/**
 * electron safeStorage → SafeStoragePort 薄壳（m1 todo 10 = T-M1-08①）。
 * key-service 本体 electron-free；electron 依赖只允许出现在本文件（组合根接线层）。
 */
import { safeStorage } from 'electron';
import type { SafeStoragePort } from './key-service';

export function createElectronSafeStoragePort(): SafeStoragePort {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plainText) => safeStorage.encryptString(plainText),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted),
  };
}
