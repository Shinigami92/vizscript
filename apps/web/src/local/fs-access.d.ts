// File System Access API parts that TypeScript's DOM lib doesn't have yet
// (Chromium only). Feature-detect with `'showDirectoryPicker' in window`.

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission(
    descriptor?: FileSystemHandlePermissionDescriptor
  ): Promise<PermissionState>;
  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor
  ): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  /** Remembers the last folder per id. */
  id?: string;
  mode?: 'read' | 'readwrite';
}

interface Window {
  showDirectoryPicker(
    options?: DirectoryPickerOptions
  ): Promise<FileSystemDirectoryHandle>;
}
