/**
 * File Saving Service for JustShare Mobile.
 * 
 * Supports saving received files from application storage into user-accessible
 * storage (e.g. Android Downloads / custom chosen directory via StorageAccessFramework,
 * or iOS sharing/saving).
 */
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

export interface SaveFileResult {
  success: boolean;
  destinationUri?: string;
  error?: string;
  cancelled?: boolean;
}

/**
 * Saves a file to user-visible storage using Android StorageAccessFramework.
 * If user cancels folder selection or if on iOS, returns appropriate status.
 */
export async function saveFileToDevice(sourceUri: string, fileName: string, mimeType?: string): Promise<SaveFileResult> {
  try {
    const fileInfo = await FileSystem.getInfoAsync(sourceUri);
    if (!fileInfo.exists) {
      return { success: false, error: 'Source file does not exist on disk' };
    }

    if (Platform.OS === 'android') {
      const SAF = FileSystem.StorageAccessFramework;
      if (!SAF) {
        return { success: false, error: 'StorageAccessFramework is not available on this device' };
      }

      // Request user to choose destination folder (e.g. Downloads / Documents)
      const permissions = await SAF.requestDirectoryPermissionsAsync();
      if (!permissions.granted) {
        return { success: false, cancelled: true, error: 'Permission to save in chosen folder was not granted' };
      }

      const parentDirUri = permissions.directoryUri;
      const effectiveMimeType = mimeType || 'application/octet-stream';

      // Remove extension for createFileAsync name parameter
      const dotIndex = fileName.lastIndexOf('.');
      const rawName = dotIndex > 0 ? fileName.substring(0, dotIndex) : fileName;
      const extension = dotIndex > 0 ? fileName.substring(dotIndex + 1) : '';

      // Create new destination file in selected SAF folder
      const targetFileUri = await SAF.createFileAsync(parentDirUri, rawName, effectiveMimeType);

      // Read source file content (base64) and write into target SAF file
      const base64Content = await FileSystem.readAsStringAsync(sourceUri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      await FileSystem.writeAsStringAsync(targetFileUri, base64Content, {
        encoding: FileSystem.EncodingType.Base64,
      });

      return {
        success: true,
        destinationUri: targetFileUri,
      };
    } else {
      // iOS / other platforms fallback
      return {
        success: false,
        error: 'Direct filesystem saving is currently supported on Android via StorageAccessFramework',
      };
    }
  } catch (err: any) {
    console.error('[FILE_SAVE] Error saving file to device:', err);
    return {
      success: false,
      error: err?.message || 'Failed to save file to device',
    };
  }
}
