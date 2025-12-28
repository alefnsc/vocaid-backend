/**
 * UUID Mock for Jest
 * 
 * Provides a mock implementation of uuid to avoid ESM import issues in tests.
 */

export const v4 = jest.fn(() => '550e8400-e29b-41d4-a716-446655440000');
export const v1 = jest.fn(() => '550e8400-e29b-41d4-a716-446655440001');
export const v5 = jest.fn(() => '550e8400-e29b-41d4-a716-446655440002');
export const validate = jest.fn((uuid: string) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
});
export const version = jest.fn(() => 4);

export default {
  v4,
  v1,
  v5,
  validate,
  version
};
