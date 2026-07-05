// Minimal ambient declarations for the parts of the File System Access API
// not present in the DOM lib shipped with the project's TypeScript version.
// Only the members actually used by src/core/fs.ts are declared.

type FsPermissionMode = 'read' | 'readwrite'

interface FsPermissionDescriptor {
  mode?: FsPermissionMode
}

interface FileSystemHandle {
  queryPermission(descriptor?: FsPermissionDescriptor): Promise<PermissionState>
  requestPermission(descriptor?: FsPermissionDescriptor): Promise<PermissionState>
}

interface OpenFilePickerOptions {
  types?: Array<{ description?: string; accept: Record<string, string[]> }>
  excludeAcceptAllOption?: boolean
  multiple?: boolean
}

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: Array<{ description?: string; accept: Record<string, string[]> }>
  excludeAcceptAllOption?: boolean
}

interface Window {
  showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>
  showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>
}
