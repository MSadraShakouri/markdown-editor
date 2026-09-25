/**
 * tree.js — flat git tree entries -> nested, filterable file tree.
 *
 * All node labels are set with textContent: repository paths are untrusted
 * input and never end up in innerHTML.
 */

const MD = /\.(md|markdown|mdown|mkd|mkdn)$/i;

export const isMarkdown = (name) => MD.test(name);

/** Build a nested tree from `GET /git/trees/{ref}?recursive=1` entries. */
export function buildTree(entries) {
  const root = { name: '', path: '', type: 'dir', children: [] };

  for (const entry of entries) {
    if (!entry.path) continue;
    const parts = entry.path.split('/');
    let node = root;

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const last = i === parts.length - 1;

      if (last && entry.type !== 'tree') {
        node.children.push({
          name: part,
          path: entry.path,
          type: entry.type === 'commit' ? 'submodule' : 'file',
          size: entry.size || 0,
        });
        break;
      }

      let child = node.children.find((c) => c.type === 'dir' && c.name === part);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join('/'), type: 'dir', children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }

  sortChildren(root);
  return root;
}

function sortChildren(node) {
  node.children.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (b.type === 'dir' && a.type !== 'dir') return 1;
    return a.name.localeCompare(b.name, 'fa', { numeric: true });
  });
  node.children.forEach((c) => c.type === 'dir' && sortChildren(c));
}

export const dirname = (path) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** Every directory path in the tree (used to restore "expand all" state). */
export function collectDirs(node, out = []) {
  for (const c of node.children) {
    if (c.type === 'dir') { out.push(c.path); collectDirs(c, out); }
  }
  return out;
}

function visible(node, query, onlyMarkdown) {
  if (node.type !== 'dir') {
    if (node.type === 'submodule') return !query;
    if (onlyMarkdown && !isMarkdown(node.name)) return false;
    return !query || node.path.toLowerCase().includes(query);
  }
  return node.children.some((c) => visible(c, query, onlyMarkdown));
}

/**
 * Render into `container`.
 * opts: { root, expanded:Set, selected, filter, onlyMarkdown, onToggle, onSelect }
 */
export function renderTree(container, opts) {
  const {
    root, expanded = new Set(), selected = '', filter = '',
    onlyMarkdown = true, onToggle = () => {}, onSelect = () => {},
  } = opts;

  container.replaceChildren();
  const query = filter.trim().toLowerCase();

  if (query) {
    renderFlat(container, root, query, onlyMarkdown, selected, onSelect);
    return;
  }
  renderBranch(container, root, { expanded, selected, onlyMarkdown, onToggle, onSelect, depth: 0 });
}

function renderFlat(container, node, query, onlyMarkdown, selected, onSelect) {
  const hits = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.type === 'dir') walk(c);
      else if (visible(c, query, onlyMarkdown)) hits.push(c);
    }
  };
  walk(node);

  if (!hits.length) {
    container.appendChild(emptyRow('چیزی پیدا نشد'));
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'tree-root';
  ul.setAttribute('role', 'group');
  for (const file of hits.slice(0, 500)) {
    ul.appendChild(fileRow(file, selected, onSelect, 0, query));
  }
  if (hits.length > 500) ul.appendChild(emptyRow(`و ${hits.length - 500} مورد دیگر…`));
  container.appendChild(ul);
}

function renderBranch(container, node, opts) {
  const { expanded, selected, onlyMarkdown, onToggle, onSelect, depth } = opts;
  const ul = document.createElement('ul');
  ul.className = depth === 0 ? 'tree-root' : 'tree-group';
  ul.setAttribute('role', 'group');

  if (!node.children.length && depth === 0) {
    container.appendChild(emptyRow('فایلی وجود ندارد'));
    return;
  }

  for (const child of node.children) {
    if (!visible(child, '', onlyMarkdown)) continue;

    if (child.type === 'dir') {
      const open = expanded.has(child.path);
      const li = document.createElement('li');
      li.className = 'tree-dir';
      li.setAttribute('role', 'treeitem');
      li.setAttribute('aria-expanded', String(open));

      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.paddingInlineStart = `${depth * 14 + 6}px`;

      const caret = document.createElement('button');
      caret.className = 'caret';
      caret.type = 'button';
      caret.textContent = open ? '▾' : '▸';
      caret.setAttribute('aria-label', open ? 'بستن پوشه' : 'باز کردن پوشه');
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        onToggle(child.path, !open);
      });

      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = child.name;

      row.append(caret, label);
      row.addEventListener('click', () => onToggle(child.path, !open));
      li.appendChild(row);

      const sub = document.createElement('div');
      renderBranch(sub, child, { ...opts, depth: depth + 1 });
      sub.hidden = !open;
      li.appendChild(sub);
      ul.appendChild(li);
    } else {
      ul.appendChild(fileRow(child, selected, onSelect, depth, ''));
    }
  }
  container.appendChild(ul);
}

function fileRow(file, selected, onSelect, depth, query) {
  const li = document.createElement('li');
  li.className = 'tree-file';
  li.setAttribute('role', 'treeitem');
  li.dataset.path = file.path;
  if (file.path === selected) {
    li.classList.add('is-selected');
    li.setAttribute('aria-selected', 'true');
  }

  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'tree-row';
  row.style.paddingInlineStart = `${depth * 14 + 22}px`;
  row.addEventListener('click', () => onSelect(file.path, file));

  const name = document.createElement('span');
  name.className = 'tree-label' + (file.type === 'submodule' ? ' is-submodule' : '');

  if (query) {
    const idx = file.path.toLowerCase().indexOf(query);
    const before = file.path.slice(0, idx);
    const hit = file.path.slice(idx, idx + query.length);
    const after = file.path.slice(idx + query.length);
    name.append(
      document.createTextNode(before),
      Object.assign(document.createElement('mark'), { textContent: hit }),
      document.createTextNode(after),
    );
  } else {
    name.textContent = file.name;
  }
  row.appendChild(name);
  if (file.type === 'submodule') {
    row.appendChild(Object.assign(document.createElement('span'), { className: 'tag', textContent: 'submodule' }));
  }
  li.appendChild(row);
  return li;
}

function emptyRow(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}
