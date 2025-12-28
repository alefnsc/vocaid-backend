/**
 * File Storage Provider Abstraction
 * 
 * Provides a unified file storage interface with environment-aware implementations:
 * - Production: AzureBlobStorageProvider (Azure Blob Storage)
 * - Development/Staging: LocalDiskStorageProvider (local filesystem)
 * 
 * Usage:
 *   import { storageProvider } from './providers/storageProvider';
 *   await storageProvider.upload('resumes', 'file.pdf', buffer, 'application/pdf');
 *   const { buffer, contentType } = await storageProvider.download('resumes', 'file.pdf');
 * 
 * @module providers/storageProvider
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config/env';
import { apiLogger } from '../utils/logger';

// ========================================
// STORAGE PROVIDER INTERFACE
// ========================================

export interface FileMetadata {
  name: string;
  size: number;
  contentType: string;
  lastModified: Date;
  etag?: string;
}

export interface UploadResult {
  success: boolean;
  key: string;
  url?: string;
  error?: string;
}

export interface DownloadResult {
  success: boolean;
  buffer?: Buffer;
  contentType?: string;
  error?: string;
}

export interface StorageProvider {
  /** Check if provider is available */
  isAvailable(): boolean;
  
  /** Upload a file */
  upload(
    container: string,
    key: string,
    data: Buffer,
    contentType: string,
    metadata?: Record<string, string>
  ): Promise<UploadResult>;
  
  /** Download a file */
  download(container: string, key: string): Promise<DownloadResult>;
  
  /** Delete a file */
  delete(container: string, key: string): Promise<boolean>;
  
  /** Check if a file exists */
  exists(container: string, key: string): Promise<boolean>;
  
  /** Get file metadata */
  getMetadata(container: string, key: string): Promise<FileMetadata | null>;
  
  /** Generate a signed URL for direct access */
  getSignedUrl(container: string, key: string, expiryMinutes?: number): Promise<string | null>;
  
  /** List files in a container */
  list(container: string, prefix?: string): Promise<FileMetadata[]>;
  
  /** Get provider name */
  getName(): string;
}

// ========================================
// LOCAL DISK STORAGE PROVIDER (DEV/STAGING)
// ========================================

class LocalDiskStorageProvider implements StorageProvider {
  private readonly baseDir: string;

  constructor() {
    this.baseDir = path.join(process.cwd(), 'storage');
    this.ensureDirectory(this.baseDir);
    apiLogger.info('[storage] Local disk storage provider initialized', {
      baseDir: this.baseDir,
    });
  }

  private ensureDirectory(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private getFilePath(container: string, key: string): string {
    const containerDir = path.join(this.baseDir, container);
    this.ensureDirectory(containerDir);
    return path.join(containerDir, key);
  }

  private getMetadataPath(filePath: string): string {
    return `${filePath}.meta.json`;
  }

  getName(): string {
    return 'LocalDiskStorageProvider';
  }

  isAvailable(): boolean {
    return true;
  }

  async upload(
    container: string,
    key: string,
    data: Buffer,
    contentType: string,
    metadata?: Record<string, string>
  ): Promise<UploadResult> {
    try {
      const filePath = this.getFilePath(container, key);
      
      // Write file
      fs.writeFileSync(filePath, data);
      
      // Write metadata
      const meta = {
        contentType,
        size: data.length,
        uploadedAt: new Date().toISOString(),
        ...metadata,
      };
      fs.writeFileSync(this.getMetadataPath(filePath), JSON.stringify(meta, null, 2));

      apiLogger.debug('[storage] File uploaded locally', { container, key, size: data.length });

      return {
        success: true,
        key,
        url: `file://${filePath}`,
      };
    } catch (error) {
      apiLogger.error('[storage] Local upload failed', { container, key, error });
      return {
        success: false,
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async download(container: string, key: string): Promise<DownloadResult> {
    try {
      const filePath = this.getFilePath(container, key);
      
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File not found' };
      }

      const buffer = fs.readFileSync(filePath);
      
      let contentType = 'application/octet-stream';
      const metaPath = this.getMetadataPath(filePath);
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          contentType = meta.contentType || contentType;
        } catch {
          // Ignore metadata parse errors
        }
      }

      return { success: true, buffer, contentType };
    } catch (error) {
      apiLogger.error('[storage] Local download failed', { container, key, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async delete(container: string, key: string): Promise<boolean> {
    try {
      const filePath = this.getFilePath(container, key);
      
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      
      const metaPath = this.getMetadataPath(filePath);
      if (fs.existsSync(metaPath)) {
        fs.unlinkSync(metaPath);
      }

      return true;
    } catch (error) {
      apiLogger.error('[storage] Local delete failed', { container, key, error });
      return false;
    }
  }

  async exists(container: string, key: string): Promise<boolean> {
    const filePath = this.getFilePath(container, key);
    return fs.existsSync(filePath);
  }

  async getMetadata(container: string, key: string): Promise<FileMetadata | null> {
    try {
      const filePath = this.getFilePath(container, key);
      
      if (!fs.existsSync(filePath)) {
        return null;
      }

      const stats = fs.statSync(filePath);
      let contentType = 'application/octet-stream';
      
      const metaPath = this.getMetadataPath(filePath);
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          contentType = meta.contentType || contentType;
        } catch {
          // Ignore metadata parse errors
        }
      }

      return {
        name: key,
        size: stats.size,
        contentType,
        lastModified: stats.mtime,
      };
    } catch {
      return null;
    }
  }

  async getSignedUrl(container: string, key: string): Promise<string | null> {
    // For local storage, just return the file path
    const filePath = this.getFilePath(container, key);
    if (fs.existsSync(filePath)) {
      return `file://${filePath}`;
    }
    return null;
  }

  async list(container: string, prefix?: string): Promise<FileMetadata[]> {
    try {
      const containerDir = path.join(this.baseDir, container);
      
      if (!fs.existsSync(containerDir)) {
        return [];
      }

      const files = fs.readdirSync(containerDir)
        .filter((f) => !f.endsWith('.meta.json'))
        .filter((f) => !prefix || f.startsWith(prefix));

      const results: FileMetadata[] = [];
      for (const file of files) {
        const meta = await this.getMetadata(container, file);
        if (meta) {
          results.push(meta);
        }
      }

      return results;
    } catch {
      return [];
    }
  }
}

// ========================================
// AZURE BLOB STORAGE PROVIDER (PRODUCTION)
// ========================================

class AzureBlobStorageProvider implements StorageProvider {
  private client: import('@azure/storage-blob').BlobServiceClient | null = null;
  private initialized = false;

  constructor() {
    if (!config.features.blobStorageEnabled) {
      apiLogger.info('[storage] Azure Blob Storage is disabled, using local disk fallback');
      return;
    }

    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const { BlobServiceClient } = await import('@azure/storage-blob');

      if (config.blobStorage.connectionString) {
        this.client = BlobServiceClient.fromConnectionString(config.blobStorage.connectionString);
        this.initialized = true;
        apiLogger.info('[storage] Azure Blob Storage initialized');
      } else {
        apiLogger.warn('[storage] Azure Blob Storage connection string not configured');
      }
    } catch (error) {
      apiLogger.error('[storage] Failed to initialize Azure Blob Storage', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  getName(): string {
    return 'AzureBlobStorageProvider';
  }

  isAvailable(): boolean {
    return this.initialized && this.client !== null;
  }

  private async getContainerClient(container: string) {
    if (!this.client) {
      throw new Error('Azure Blob Storage not initialized');
    }
    
    const containerClient = this.client.getContainerClient(container);
    
    // Ensure container exists
    if (!(await containerClient.exists())) {
      await containerClient.create({ access: 'blob' });
    }
    
    return containerClient;
  }

  async upload(
    container: string,
    key: string,
    data: Buffer,
    contentType: string,
    metadata?: Record<string, string>
  ): Promise<UploadResult> {
    if (!this.isAvailable()) {
      return { success: false, key, error: 'Storage not available' };
    }

    try {
      const containerClient = await this.getContainerClient(container);
      const blobClient = containerClient.getBlockBlobClient(key);

      await blobClient.upload(data, data.length, {
        blobHTTPHeaders: { blobContentType: contentType },
        metadata,
      });

      apiLogger.debug('[storage] File uploaded to Azure', { container, key, size: data.length });

      return {
        success: true,
        key,
        url: blobClient.url,
      };
    } catch (error) {
      apiLogger.error('[storage] Azure upload failed', { container, key, error });
      return {
        success: false,
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async download(container: string, key: string): Promise<DownloadResult> {
    if (!this.isAvailable()) {
      return { success: false, error: 'Storage not available' };
    }

    try {
      const containerClient = await this.getContainerClient(container);
      const blobClient = containerClient.getBlockBlobClient(key);

      const response = await blobClient.download();
      const chunks: Buffer[] = [];
      
      for await (const chunk of response.readableStreamBody as NodeJS.ReadableStream) {
        // Handle chunk as Uint8Array, Buffer, or string
        if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk);
        } else if (typeof chunk === 'string') {
          chunks.push(Buffer.from(chunk, 'utf-8'));
        } else {
          chunks.push(Buffer.from(chunk));
        }
      }

      return {
        success: true,
        buffer: Buffer.concat(chunks),
        contentType: response.contentType || 'application/octet-stream',
      };
    } catch (error) {
      apiLogger.error('[storage] Azure download failed', { container, key, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async delete(container: string, key: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const containerClient = await this.getContainerClient(container);
      const blobClient = containerClient.getBlockBlobClient(key);
      await blobClient.delete();
      return true;
    } catch (error) {
      apiLogger.error('[storage] Azure delete failed', { container, key, error });
      return false;
    }
  }

  async exists(container: string, key: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const containerClient = await this.getContainerClient(container);
      const blobClient = containerClient.getBlockBlobClient(key);
      return await blobClient.exists();
    } catch {
      return false;
    }
  }

  async getMetadata(container: string, key: string): Promise<FileMetadata | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const containerClient = await this.getContainerClient(container);
      const blobClient = containerClient.getBlockBlobClient(key);
      const props = await blobClient.getProperties();

      return {
        name: key,
        size: props.contentLength || 0,
        contentType: props.contentType || 'application/octet-stream',
        lastModified: props.lastModified || new Date(),
        etag: props.etag,
      };
    } catch {
      return null;
    }
  }

  async getSignedUrl(container: string, key: string, expiryMinutes = 60): Promise<string | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const { generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = 
        await import('@azure/storage-blob');
      
      // For SAS URL generation, we need the account name and key
      // This is a simplified version - in production you might use managed identity
      if (!config.blobStorage.accountName || !config.blobStorage.sasToken) {
        // Return the direct URL if no SAS token is configured
        const containerClient = await this.getContainerClient(container);
        const blobClient = containerClient.getBlockBlobClient(key);
        return blobClient.url;
      }

      const containerClient = await this.getContainerClient(container);
      const blobClient = containerClient.getBlockBlobClient(key);
      
      // Simple URL return if SAS is pre-configured
      return `${blobClient.url}?${config.blobStorage.sasToken}`;
    } catch {
      return null;
    }
  }

  async list(container: string, prefix?: string): Promise<FileMetadata[]> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const containerClient = await this.getContainerClient(container);
      const results: FileMetadata[] = [];

      for await (const blob of containerClient.listBlobsFlat({ prefix })) {
        results.push({
          name: blob.name,
          size: blob.properties.contentLength || 0,
          contentType: blob.properties.contentType || 'application/octet-stream',
          lastModified: blob.properties.lastModified || new Date(),
          etag: blob.properties.etag,
        });
      }

      return results;
    } catch {
      return [];
    }
  }
}

// ========================================
// PROVIDER FACTORY
// ========================================

function createStorageProvider(): StorageProvider {
  if (config.features.blobStorageEnabled) {
    const azure = new AzureBlobStorageProvider();
    if (!azure.isAvailable()) {
      apiLogger.warn('[storage] Azure Blob unavailable, using local disk fallback');
      return new LocalDiskStorageProvider();
    }
    return azure;
  }
  
  return new LocalDiskStorageProvider();
}

// Export singleton instance
export const storageProvider = createStorageProvider();

export default storageProvider;
