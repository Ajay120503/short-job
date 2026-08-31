const toId = (value) => {
  if (!value) return '';
  return String(value._id || value);
};

const getViewerPriorityOwnerIds = (viewer) => {
  const ids = new Set();
  const viewerId = toId(viewer);
  if (viewerId) ids.add(viewerId);

  (viewer?.following || []).forEach((followedUser) => {
    const followedId = toId(followedUser);
    if (followedId) ids.add(followedId);
  });

  return ids;
};

const compareByPriorityAndNewest = (viewer, ownerSelector, dateSelector = (item) => item.createdAt) => {
  const priorityOwnerIds = getViewerPriorityOwnerIds(viewer);

  return (a, b) => {
    const aPriority = priorityOwnerIds.has(toId(ownerSelector(a)));
    const bPriority = priorityOwnerIds.has(toId(ownerSelector(b)));
    if (aPriority !== bPriority) return aPriority ? -1 : 1;

    const aTime = new Date(dateSelector(a) || 0).getTime();
    const bTime = new Date(dateSelector(b) || 0).getTime();
    return bTime - aTime;
  };
};

const sortByPriorityAndNewest = (items, viewer, ownerSelector, dateSelector) =>
  [...items].sort(compareByPriorityAndNewest(viewer, ownerSelector, dateSelector));

const pickPriorityPage = (items, viewer, ownerSelector, skip = 0, limit = items.length, dateSelector) =>
  sortByPriorityAndNewest(items, viewer, ownerSelector, dateSelector).slice(skip, skip + limit);

module.exports = {
  pickPriorityPage,
  sortByPriorityAndNewest,
  toId,
};
