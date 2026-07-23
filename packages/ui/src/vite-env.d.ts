/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HOME_SHELL?: "legacy" | "thread"
}

/** File System Access API — folder picker for "Save locally". */
interface FileSystemCreateWritableOptions {
  keepExistingData?: boolean
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: BufferSource | Blob | string): Promise<void>
  close(): Promise<void>
}

interface FileSystemFileHandle extends FileSystemHandle {
  kind: "file"
  createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream>
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  kind: "directory"
  readonly name: string
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>
}

interface DirectoryPickerOptions {
  id?: string
  mode?: "read" | "readwrite"
  startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos"
}

interface Window {
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>
}
