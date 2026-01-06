#!/bin/bash
# =============================================================================
# Email Routes E2E Test Script
# =============================================================================
#
# Manual testing script for Resend email integration
# Run after starting the backend server with EMAIL_PROVIDER_MODE=mock
#
# Usage:
#   ./scripts/test-email-routes.sh
#
# Prerequisites:
#   - Backend running on http://localhost:3001
#   - Valid session auth (or mock auth enabled)
#   - ADMIN_SECRET_KEY and CRON_SECRET environment variables set
#
# =============================================================================

set -e

# Configuration
BASE_URL="${API_URL:-http://localhost:3001}"
ADMIN_SECRET="${ADMIN_SECRET_KEY:-test-admin-secret-key-12345}"
CRON_SECRET="${CRON_SECRET:-test-cron-secret-12345}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
PASSED=0
FAILED=0

# Helper functions
print_header() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

print_test() {
    echo -e "${YELLOW}▶ Test: $1${NC}"
}

print_pass() {
    echo -e "${GREEN}✓ PASS: $1${NC}"
    ((PASSED++))
}

print_fail() {
    echo -e "${RED}✗ FAIL: $1${NC}"
    echo -e "${RED}  Response: $2${NC}"
    ((FAILED++))
}

check_json_field() {
    local json="$1"
    local field="$2"
    local expected="$3"
    local actual=$(echo "$json" | jq -r "$field" 2>/dev/null)
    
    if [ "$actual" = "$expected" ]; then
        return 0
    else
        return 1
    fi
}

# =============================================================================
# ADMIN ROUTES TESTS
# =============================================================================

print_header "Admin Routes Authentication Tests"

# Test 1: Reject missing admin secret
print_test "Admin routes should reject requests without X-Admin-Secret"
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/api/admin/emails/types")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n1)

if [ "$HTTP_CODE" = "401" ] && echo "$BODY" | jq -e '.ok == false' > /dev/null 2>&1; then
    print_pass "Returns 401 Unauthorized without header"
else
    print_fail "Expected 401 with ok:false" "$BODY"
fi

# Test 2: Reject invalid admin secret
print_test "Admin routes should reject invalid X-Admin-Secret"
RESPONSE=$(curl -s -w "\n%{http_code}" -H "X-Admin-Secret: wrong-secret" "$BASE_URL/api/admin/emails/types")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n1)

if [ "$HTTP_CODE" = "401" ]; then
    print_pass "Returns 401 with invalid secret"
else
    print_fail "Expected 401" "$HTTP_CODE"
fi

# Test 3: Accept valid admin secret
print_test "Admin routes should accept valid X-Admin-Secret"
RESPONSE=$(curl -s -w "\n%{http_code}" -H "X-Admin-Secret: $ADMIN_SECRET" "$BASE_URL/api/admin/emails/types")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n1)

if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | jq -e '.ok == true' > /dev/null 2>&1; then
    print_pass "Returns 200 with valid secret"
else
    print_fail "Expected 200 with ok:true" "$BODY"
fi

# =============================================================================
# GET /api/admin/emails/types
# =============================================================================

print_header "GET /api/admin/emails/types"

print_test "Should return list of email types"
RESPONSE=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$BASE_URL/api/admin/emails/types")

if echo "$RESPONSE" | jq -e '.ok == true and (.data | type == "array")' > /dev/null 2>&1; then
    TYPES_COUNT=$(echo "$RESPONSE" | jq '.data | length')
    print_pass "Returns array of $TYPES_COUNT email types"
else
    print_fail "Expected ok:true with data array" "$RESPONSE"
fi

print_test "Response should have requestId"
if echo "$RESPONSE" | jq -e '.requestId != null' > /dev/null 2>&1; then
    REQUEST_ID=$(echo "$RESPONSE" | jq -r '.requestId')
    print_pass "requestId present: ${REQUEST_ID:0:20}..."
else
    print_fail "Missing requestId" "$RESPONSE"
fi

# =============================================================================
# GET /api/admin/emails/stats
# =============================================================================

print_header "GET /api/admin/emails/stats"

print_test "Should return email statistics"
RESPONSE=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$BASE_URL/api/admin/emails/stats")

if echo "$RESPONSE" | jq -e '.ok == true' > /dev/null 2>&1; then
    print_pass "Returns stats with ok:true"
else
    print_fail "Expected ok:true" "$RESPONSE"
fi

print_test "Should support date range filtering"
FROM_DATE=$(date -u -v-30d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)
TO_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RESPONSE=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$BASE_URL/api/admin/emails/stats?fromDate=$FROM_DATE&toDate=$TO_DATE")

if echo "$RESPONSE" | jq -e '.ok == true' > /dev/null 2>&1; then
    print_pass "Date range filtering works"
else
    print_fail "Date range filtering failed" "$RESPONSE"
fi

# =============================================================================
# GET /api/admin/emails/preview/:type
# =============================================================================

print_header "GET /api/admin/emails/preview/:type"

EMAIL_TYPES=("welcome" "purchase" "low-credits" "interview-reminder" "interview-complete")

for TYPE in "${EMAIL_TYPES[@]}"; do
    print_test "Preview $TYPE email (JSON)"
    RESPONSE=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$BASE_URL/api/admin/emails/preview/$TYPE")
    
    if echo "$RESPONSE" | jq -e '.ok == true and .data.html != null and .data.subject != null' > /dev/null 2>&1; then
        SUBJECT=$(echo "$RESPONSE" | jq -r '.data.subject')
        print_pass "$TYPE preview - Subject: $SUBJECT"
    else
        print_fail "Preview $TYPE failed" "$RESPONSE"
    fi
done

print_test "Preview with Portuguese language"
RESPONSE=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$BASE_URL/api/admin/emails/preview/welcome?lang=pt")
if echo "$RESPONSE" | jq -e '.data.language == "pt"' > /dev/null 2>&1; then
    print_pass "Portuguese preview works"
else
    print_fail "Portuguese preview failed" "$RESPONSE"
fi

print_test "Preview as HTML format"
RESPONSE=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$BASE_URL/api/admin/emails/preview/welcome?format=html")
if echo "$RESPONSE" | grep -q "<!DOCTYPE html"; then
    print_pass "HTML format returns raw HTML"
else
    print_fail "HTML format should return raw HTML" "${RESPONSE:0:100}..."
fi

print_test "Reject invalid email type"
RESPONSE=$(curl -s -w "\n%{http_code}" -H "X-Admin-Secret: $ADMIN_SECRET" "$BASE_URL/api/admin/emails/preview/invalid-type")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n1)

if [ "$HTTP_CODE" = "400" ] && echo "$BODY" | jq -e '.error.code == "INVALID_TYPE"' > /dev/null 2>&1; then
    print_pass "Returns 400 for invalid type"
else
    print_fail "Expected 400 with INVALID_TYPE error" "$BODY"
fi

# =============================================================================
# POST /api/admin/emails/test
# =============================================================================

print_header "POST /api/admin/emails/test"

print_test "Send test email"
RESPONSE=$(curl -s -X POST -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/json" \
    -d '{"type":"welcome","to":"test@example.com","lang":"en"}' \
    "$BASE_URL/api/admin/emails/test")

if echo "$RESPONSE" | jq -e '.ok == true' > /dev/null 2>&1; then
    print_pass "Test email request accepted"
else
    print_fail "Test email failed" "$RESPONSE"
fi

print_test "Reject missing fields"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/json" \
    -d '{"type":"welcome"}' \
    "$BASE_URL/api/admin/emails/test")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n1)

if [ "$HTTP_CODE" = "400" ]; then
    print_pass "Returns 400 for missing 'to' field"
else
    print_fail "Expected 400" "$BODY"
fi

# =============================================================================
# POST /api/admin/emails/cron/reminders
# =============================================================================

print_header "POST /api/admin/emails/cron/reminders"

print_test "Reject admin secret for cron endpoint"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/json" \
    -d '{}' \
    "$BASE_URL/api/admin/emails/cron/reminders")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)

if [ "$HTTP_CODE" = "401" ]; then
    print_pass "Cron endpoint rejects admin secret"
else
    print_fail "Expected 401 when using admin secret" "$HTTP_CODE"
fi

print_test "Accept cron secret"
RESPONSE=$(curl -s -X POST -H "X-Cron-Secret: $CRON_SECRET" -H "Content-Type: application/json" \
    -d '{"daysSinceLastPractice":7,"maxReminders":10}' \
    "$BASE_URL/api/admin/emails/cron/reminders")

if echo "$RESPONSE" | jq -e '.ok == true' > /dev/null 2>&1; then
    print_pass "Cron endpoint accepts cron secret"
else
    print_fail "Cron endpoint failed" "$RESPONSE"
fi

# =============================================================================
# RESPONSE CONTRACT TESTS
# =============================================================================

print_header "Response Contract Validation"

print_test "All success responses have: ok, data, requestId"
RESPONSE=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$BASE_URL/api/admin/emails/types")

OK=$(echo "$RESPONSE" | jq -r '.ok')
HAS_DATA=$(echo "$RESPONSE" | jq -e '.data != null' > /dev/null 2>&1 && echo "yes" || echo "no")
HAS_REQUEST_ID=$(echo "$RESPONSE" | jq -e '.requestId != null' > /dev/null 2>&1 && echo "yes" || echo "no")

if [ "$OK" = "true" ] && [ "$HAS_DATA" = "yes" ] && [ "$HAS_REQUEST_ID" = "yes" ]; then
    print_pass "Success response contract valid"
else
    print_fail "Missing fields: ok=$OK data=$HAS_DATA requestId=$HAS_REQUEST_ID" "$RESPONSE"
fi

print_test "All error responses have: ok, error.code, error.message, requestId"
RESPONSE=$(curl -s "$BASE_URL/api/admin/emails/types")  # No auth header

OK=$(echo "$RESPONSE" | jq -r '.ok')
ERROR_CODE=$(echo "$RESPONSE" | jq -r '.error.code')
ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error.message')
HAS_REQUEST_ID=$(echo "$RESPONSE" | jq -e '.requestId != null' > /dev/null 2>&1 && echo "yes" || echo "no")

if [ "$OK" = "false" ] && [ "$ERROR_CODE" != "null" ] && [ "$ERROR_MSG" != "null" ] && [ "$HAS_REQUEST_ID" = "yes" ]; then
    print_pass "Error response contract valid"
else
    print_fail "Invalid error format: ok=$OK code=$ERROR_CODE msg=$ERROR_MSG requestId=$HAS_REQUEST_ID" "$RESPONSE"
fi

print_test "Content-Type is always application/json"
CONTENT_TYPE=$(curl -s -I -H "X-Admin-Secret: $ADMIN_SECRET" "$BASE_URL/api/admin/emails/types" | grep -i "content-type" | head -1)

if echo "$CONTENT_TYPE" | grep -qi "application/json"; then
    print_pass "Content-Type is application/json"
else
    print_fail "Expected application/json" "$CONTENT_TYPE"
fi

# =============================================================================
# SUMMARY
# =============================================================================

print_header "Test Summary"

TOTAL=$((PASSED + FAILED))
echo ""
echo -e "  ${GREEN}Passed: $PASSED${NC}"
echo -e "  ${RED}Failed: $FAILED${NC}"
echo -e "  Total:  $TOTAL"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed! ✓${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed. Please review the output above.${NC}"
    exit 1
fi
