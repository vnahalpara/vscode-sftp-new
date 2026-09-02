// A workspace folder reduced to what grouping needs. Deliberately not
// vscode.WorkspaceFolder: this module has to stay importable by jest, which
// has no vscode module to give it. Callers carry the real folder along in a
// record that extends this one.
export interface GroupingFolder {
  name: string;
  fsPath: string;
}

export interface FolderGroup<T, F extends GroupingFolder> {
  folder: F;
  items: T[];
}

/** Grouping starts at two folders; one folder shows a flat tree, as it always has. */
export function shouldGroup(folders: GroupingFolder[]): boolean {
  return folders.length >= 2;
}

/**
 * One group per workspace folder that owns at least one item, in workspace
 * folder order, each group keeping the incoming order of its items (the trees
 * sort before they group).
 */
export function groupByWorkspaceFolder<T, F extends GroupingFolder>(
  items: T[],
  folderOf: (item: T) => string,
  folders: F[]
): FolderGroup<T, F>[] {
  const groups: FolderGroup<T, F>[] = [];
  folders.forEach(folder => {
    const owned = items.filter(item => folderOf(item) === folder.fsPath);
    if (owned.length > 0) {
      groups.push({ folder, items: owned });
    }
  });
  return groups;
}
