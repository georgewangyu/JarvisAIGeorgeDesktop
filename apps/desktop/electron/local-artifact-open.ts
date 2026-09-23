// An artifact's file URL belongs to this machine only in local mode. Keep the
// OS result in the IPC promise so the Library can report a failed open.
export interface LocalArtifactOpenDeps {
  resolvePath: (url: string, options: { purpose: string }) => string
  openPath: (path: string) => Promise<string>
}

export async function openLocalArtifact(url: string, { resolvePath, openPath }: LocalArtifactOpenDeps): Promise<void> {
  const localPath = resolvePath(url, { purpose: 'Open external file' })
  const error = await openPath(localPath)

  if (error) {
    throw new Error(error)
  }
}
