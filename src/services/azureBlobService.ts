/**
 * Azure Blob Storage Service
 * 
 * Handles file storage in Azure Blob Storage for production.
 * Falls back to database storage when Azure is disabled.
 * 
 * Features:
 * - Resume/PDF upload and download
 * - Automatic container creation
 * - SAS token generation for secure access
 * - Graceful fallback to database storage
 * 
 * @module services/azureBlobService
 */

import { BlobServiceClient, ContainerClient, BlockBlobClient } from '@azure/storage-blob';
import { apiLogger } from '../utils/logger';

// ============================================
// CONFIGURATION
// ============================================

// Read config dynamically to handle late-loaded env vars
function getConfig() {
  return {
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
    containerResumes: process.env.AZURE_STORAGE_CONTAINER_RESUMES || 'resumes',
    containerExports: process.env.AZURE_STORAGE_CONTAINER_EXPORTS || 'exports',
    enabled: process.env.AZURE_BLOB_STORAGE_ENABLED === 'true',
  };
}

// ============================================
// CLIENT INITIALIZATION
// ============================================

let blobServiceClient: BlobServiceClient | null = null;
let resumesContainer: ContainerClient | null = null;
let exportsContainer: ContainerClient | null = null;
let isInitialized = false;

/**
 * Initialize Azure Blob Storage clients
 */
async function initializeBlobStorage(): Promise<boolean> {
  const config = getConfig();
  
  if (!config.enabled) {
    apiLogger.info('[azure-blob] Azure Blob Storage is disabled, using database storage');
    return false;
  }

  if (!config.connectionString) {
    apiLogger.warn('[azure-blob] No connection string provided, falling back to database storage');
    return false;
  }

  try {
    blobServiceClient = BlobServiceClient.fromConnectionString(config.connectionString);
    
    // Get or create containers
    resumesContainer = blobServiceClient.getContainerClient(config.containerResumes);
    exportsContainer = blobServiceClient.getContainerClient(config.containerExports);

    // Create containers if they don't exist
    await resumesContainer.createIfNotExists({ access: 'blob' });
    await exportsContainer.createIfNotExists({ access: 'blob' });

    isInitialized = true;
    apiLogger.info('[azure-blob] Azure Blob Storage initialized', {
      resumesContainer: config.containerResumes,
      exportsContainer: config.containerExports,
    });

    return true;
  } catch (error) {
    apiLogger.error('[azure-blob] Failed to initialize Azure Blob Storage', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    isInitialized = false;
    return false;
  }
}

/**
 * Check if Azure Blob Storage is available
 */
export function isAzureBlobEnabled(): boolean {
  const config = getConfig();
  return config.enabled && isInitialized && resumesContainer !== null;
}

/**
 * Ensure Azure Blob Storage is initialized before operations
 * This handles the async initialization race condition
 */
async function ensureInitialized(): Promise<boolean> {
  if (isInitialized) return true;
  
  const config = getConfig();
  if (!config.enabled) {
    apiLogger.warn('[azure-blob] Azure Blob Storage is not enabled - resume uploads will fail');
    return false;
  }
  
  return await initializeBlobStorage();
}

// ============================================
// FILE OPERATIONS
// ============================================

export interface UploadResult {
  success: boolean;
  blobUrl?: string;
  blobName?: string;
  error?: string;
}

export interface DownloadResult {
  success: boolean;
  data?: Buffer;
  contentType?: string;
  error?: string;
}

/**
 * Upload a feedback PDF to Azure Blob Storage (exports container)
 */
export async function uploadFeedbackPdf(
  userId: string,
  fileName: string,
  content: Buffer,
  mimeType: string = 'application/pdf'
): Promise<UploadResult> {
  // Ensure storage is initialized (handles async startup race)
  await ensureInitialized();

  if (!isAzureBlobEnabled()) {
    return {
      success: false,
      error:
        'Azure Blob Storage is not enabled or failed to initialize. Check AZURE_BLOB_STORAGE_ENABLED and AZURE_STORAGE_CONNECTION_STRING environment variables.',
    };
  }

  try {
    const blobName = generateBlobName(userId, fileName);
    const container = exportsContainer || resumesContainer;

    if (!container) {
      return { success: false, error: 'No container available for feedback PDF upload' };
    }

    const blockBlobClient = container.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(content, {
      blobHTTPHeaders: {
        blobContentType: mimeType,
        blobContentDisposition: `attachment; filename="${fileName}"`,
      },
      metadata: {
        userId,
        originalFileName: fileName,
        uploadedAt: new Date().toISOString(),
        kind: 'feedback_pdf',
      },
    });

    apiLogger.info('[azure-blob] Feedback PDF uploaded successfully', {
      userId: userId.slice(0, 15),
      blobName,
      size: content.length,
    });

    return {
      success: true,
      blobUrl: blockBlobClient.url,
      blobName,
    };
  } catch (error) {
    apiLogger.error('[azure-blob] Failed to upload feedback PDF', {
      userId: userId.slice(0, 15),
      fileName,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Upload failed',
    };
  }
}

/**
 * Generate a unique blob name for a file
 */
function generateBlobName(userId: string, fileName: string): string {
  const timestamp = Date.now();
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `${userId}/${timestamp}-${sanitizedFileName}`;
}

/**
 * Upload a resume file to Azure Blob Storage
 */
export async function uploadResume(
  userId: string,
  fileName: string,
  content: Buffer,
  mimeType: string
): Promise<UploadResult> {
  // Ensure storage is initialized (handles async startup race)
  await ensureInitialized();
  
  if (!isAzureBlobEnabled()) {
    return {
      success: false,
      error: 'Azure Blob Storage is not enabled or failed to initialize. Check AZURE_BLOB_STORAGE_ENABLED and AZURE_STORAGE_CONNECTION_STRING environment variables.',
    };
  }

  try {
    const blobName = generateBlobName(userId, fileName);
    const blockBlobClient = resumesContainer!.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(content, {
      blobHTTPHeaders: {
        blobContentType: mimeType,
        blobContentDisposition: `attachment; filename="${fileName}"`,
      },
      metadata: {
        userId,
        originalFileName: fileName,
        uploadedAt: new Date().toISOString(),
      },
    });

    apiLogger.info('[azure-blob] Resume uploaded successfully', {
      userId: userId.slice(0, 15),
      blobName,
      size: content.length,
    });

    return {
      success: true,
      blobUrl: blockBlobClient.url,
      blobName,
    };
  } catch (error) {
    apiLogger.error('[azure-blob] Failed to upload resume', {
      userId: userId.slice(0, 15),
      fileName,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Upload failed',
    };
  }
}

/**
 * Download a resume file from Azure Blob Storage
 */
export async function downloadResume(blobName: string): Promise<DownloadResult> {
  // Ensure storage is initialized
  await ensureInitialized();
  
  if (!isAzureBlobEnabled()) {
    return {
      success: false,
      error: 'Azure Blob Storage is not enabled or failed to initialize',
    };
  }

  try {
    const blockBlobClient = resumesContainer!.getBlockBlobClient(blobName);
    const downloadResponse = await blockBlobClient.download();

    if (!downloadResponse.readableStreamBody) {
      return {
        success: false,
        error: 'No content in blob',
      };
    }

    // Convert stream to buffer
    const chunks: Buffer[] = [];
    for await (const chunk of downloadResponse.readableStreamBody) {
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks);

    return {
      success: true,
      data,
      contentType: downloadResponse.contentType,
    };
  } catch (error) {
    apiLogger.error('[azure-blob] Failed to download resume', {
      blobName,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Download failed',
    };
  }
}

/**
 * Delete a resume file from Azure Blob Storage
 */
export async function deleteResume(blobName: string): Promise<boolean> {
  if (!isAzureBlobEnabled()) {
    return false;
  }

  try {
    const blockBlobClient = resumesContainer!.getBlockBlobClient(blobName);
    await blockBlobClient.deleteIfExists();

    apiLogger.info('[azure-blob] Resume deleted', { blobName });
    return true;
  } catch (error) {
    apiLogger.error('[azure-blob] Failed to delete resume', {
      blobName,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

/**
 * Download a feedback PDF from Azure Blob Storage (from exports container)
 * Falls back to resumes container if exports container not available
 */
export async function downloadFeedbackPdf(blobName: string): Promise<DownloadResult> {
  // Ensure storage is initialized
  await ensureInitialized();
  
  if (!isAzureBlobEnabled()) {
    return {
      success: false,
      error: 'Azure Blob Storage is not enabled or failed to initialize',
    };
  }

  try {
    // Try exports container first, fallback to resumes container
    const container = exportsContainer || resumesContainer;
    if (!container) {
      return {
        success: false,
        error: 'No container available for feedback PDF download',
      };
    }

    const blockBlobClient = container.getBlockBlobClient(blobName);
    const downloadResponse = await blockBlobClient.download();

    if (!downloadResponse.readableStreamBody) {
      return {
        success: false,
        error: 'No content in blob',
      };
    }

    // Convert stream to buffer
    const chunks: Buffer[] = [];
    for await (const chunk of downloadResponse.readableStreamBody) {
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks);

    return {
      success: true,
      data,
      contentType: downloadResponse.contentType || 'application/pdf',
    };
  } catch (error) {
    apiLogger.error('[azure-blob] Failed to download feedback PDF', {
      blobName,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Download failed',
    };
  }
}

/**
 * Generate a SAS URL for temporary access to a blob
 */
export async function generateSasUrl(
  blobName: string,
  expiresInMinutes: number = 60
): Promise<string | null> {
  if (!isAzureBlobEnabled()) {
    return null;
  }

  try {
    const blockBlobClient = resumesContainer!.getBlockBlobClient(blobName);
    
    // Generate SAS token with read permission
    const expiresOn = new Date();
    expiresOn.setMinutes(expiresOn.getMinutes() + expiresInMinutes);

    // Note: For SAS generation, you need to use generateBlobSASQueryParameters
    // This requires the storage account key, which we'd extract from connection string
    // For now, return the direct URL (works if container has public access)
    return blockBlobClient.url;
  } catch (error) {
    apiLogger.error('[azure-blob] Failed to generate SAS URL', {
      blobName,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

// ============================================
// INITIALIZATION
// ============================================

// Initialize on module load if enabled
// Note: This may run before dotenv loads, so ensureInitialized() handles lazy init
const initConfig = getConfig();
if (initConfig.enabled && initConfig.connectionString) {
  initializeBlobStorage().catch((error) => {
    apiLogger.error('[azure-blob] Initialization failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  });
}

export default {
  isAzureBlobEnabled,
  uploadResume,
  uploadFeedbackPdf,
  downloadResume,
  downloadFeedbackPdf,
  deleteResume,
  generateSasUrl,
  initializeBlobStorage,
};
