import { groupByWorkspaceFolder, shouldGroup } from '../explorerGrouping';

interface Service {
  name: string;
  folder: string;
}

const hostkicker = { name: 'hostkicker', fsPath: '/ws/hostkicker' };
const devServer = { name: 'DevServer', fsPath: '/ws/DevServer' };
const empty = { name: 'empty', fsPath: '/ws/empty' };

function service(name: string, folder: string): Service {
  return { name, folder };
}

describe('shouldGroup', () => {
  it('is false with no folders', () => {
    expect(shouldGroup([])).toBe(false);
  });

  it('is false with one folder, so a single-folder workspace looks as it always has', () => {
    expect(shouldGroup([hostkicker])).toBe(false);
  });

  it('is true with two folders', () => {
    expect(shouldGroup([hostkicker, devServer])).toBe(true);
  });
});

describe('groupByWorkspaceFolder', () => {
  const folderOf = (s: Service) => s.folder;

  it('puts each item under its own folder', () => {
    const items = [
      service('a', '/ws/hostkicker'),
      service('b', '/ws/DevServer'),
      service('c', '/ws/DevServer'),
    ];
    expect(groupByWorkspaceFolder(items, folderOf, [hostkicker, devServer])).toEqual([
      { folder: hostkicker, items: [items[0]] },
      { folder: devServer, items: [items[1], items[2]] },
    ]);
  });

  it('omits a folder with no items', () => {
    const items = [service('a', '/ws/hostkicker')];
    const groups = groupByWorkspaceFolder(items, folderOf, [hostkicker, empty, devServer]);
    expect(groups.map(group => group.folder.name)).toEqual(['hostkicker']);
  });

  it('keeps workspace-folder order, not item order', () => {
    const items = [service('a', '/ws/DevServer'), service('b', '/ws/hostkicker')];
    const groups = groupByWorkspaceFolder(items, folderOf, [hostkicker, devServer]);
    expect(groups.map(group => group.folder.name)).toEqual(['hostkicker', 'DevServer']);
  });

  // The callers sort by remoteExplorer.order then name BEFORE grouping, so the
  // order inside a group has to survive untouched.
  it('keeps the incoming order inside a group', () => {
    const items = [
      service('z', '/ws/DevServer'),
      service('a', '/ws/DevServer'),
      service('m', '/ws/DevServer'),
    ];
    const groups = groupByWorkspaceFolder(items, folderOf, [devServer]);
    expect(groups[0].items.map(item => item.name)).toEqual(['z', 'a', 'm']);
  });

  it('drops an item whose folder is not in the list', () => {
    const items = [service('a', '/ws/hostkicker'), service('gone', '/ws/removed')];
    const groups = groupByWorkspaceFolder(items, folderOf, [hostkicker]);
    expect(groups).toEqual([{ folder: hostkicker, items: [items[0]] }]);
  });

  it('returns no groups for no items', () => {
    expect(groupByWorkspaceFolder([] as Service[], folderOf, [hostkicker])).toEqual([]);
  });
});
