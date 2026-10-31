'use strict';
const { AppError } = require('../lib/errors');
const { catalog } = require('../repo/catalog');

// ponytail: groups are a flat list with parent_id; the tree is built in the client
// (client/src/lib/groups.mjs) — no nested subtree is stored
// ponytail: pure handlers (JSON in/out); the HTTP router is mounted in main
function groupRoutes(store) {
  const groups = store.catalog.groups;
  return {
    'GET /api/v1/groups': async () => groups.list(),

    'POST /api/v1/groups': async (body = {}) => {
      if (!body.name) throw new AppError('group_name_required');
      const parent_id = body.parent_id ?? null;
      if (parent_id && !(await groups.get(parent_id))) throw new AppError('parent_group_not_found');
      return groups.create({ name: body.name, parent_id });
    },

    // ponytail: the id comes from the dynamic route (pathParams), the rest from the body
    'PATCH /api/v1/groups/:id': async ({ id, name, parent_id } = {}) => {
      const g = await groups.get(id);
      if (!g) throw new AppError('group_not_found');
      if (name !== undefined && !name) throw new AppError('group_name_required');
      if (parent_id !== undefined && parent_id !== null) {
        if (!(await groups.get(parent_id))) throw new AppError('parent_group_not_found');
        // ponytail: moving into itself/a descendant would create a cycle; the repository's
        // subtree query already leaves the group itself out, so the direct case is checked here
        if (parent_id === id || (await groups.descendants(id)).includes(parent_id)) {
          throw new AppError('group_cycle');
        }
      }
      return groups.update(id, { name, parent_id });
    },

    // ponytail: the FKs are ON DELETE SET NULL, but the old behavior is kept: children groups and
    // the group's cameras climb to the deleted group's parent (root when it had none). Read,
    // promote and remove happen in one transaction.
    'DELETE /api/v1/groups/:id': async ({ id } = {}) => {
      await store.tx(async (tx) => {
        const scope = tx.catalog || catalog(tx); // pg's tx hands the client, the mem store hands itself
        const g = await scope.groups.get(id);
        if (!g) throw new AppError('group_not_found');
        const parent_id = g.parent_id ?? null;
        await scope.groups.promoteChildren(id, parent_id);
        // the cameras of the deleted group follow its children: same level, not the root
        for (const c of await scope.cameras.listCatalog()) {
          if (c.group_id === id) await scope.cameras.update(c.id, { group_id: parent_id });
        }
        await scope.groups.remove(id);
      });
      return { deleted: id };
    },
  };
}

module.exports = { groupRoutes };
