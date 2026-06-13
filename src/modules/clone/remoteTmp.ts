// Stage temp archives INSIDE remotePath so both the SSH exec shell and the (often chrooted)
// SFTP subsystem resolve to the same file. `/tmp` is unreliable on hosts like Cloudways where
// SFTP is jailed to the account/app directory.
//
// For Magento, remotePath is the app root and the web root is <remotePath>/pub, so a dotfile dir
// here is not web-served. (WordPress, where the web root == remotePath, will need a different spot.)
export function remoteTmpDir(remotePath: string): string {
  return `${remotePath}/.sftp-clone-tmp`;
}

export function remoteTmpFile(remotePath: string, name: string): string {
  return `${remoteTmpDir(remotePath)}/${name}`;
}

// Name of the temp dir relative to remotePath, for tar --exclude.
export const TMP_DIRNAME = '.sftp-clone-tmp';
