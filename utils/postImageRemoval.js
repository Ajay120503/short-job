const resolvePostImageRemoval = (value, images) => {
  let requested = value || [];
  if (typeof requested === 'string') {
    try { requested = JSON.parse(requested); }
    catch { requested = requested.split(',').map((id) => id.trim()).filter(Boolean); }
  }
  if (!Array.isArray(requested) || requested.some((id) => typeof id !== 'string')) {
    throw new Error('Select valid images to remove.');
  }
  const owned = new Set(images.map((image) => image.publicId));
  if (requested.some((id) => !owned.has(id))) {
    throw new Error('You can only remove images attached to this post.');
  }
  return [...new Set(requested)];
};

module.exports = { resolvePostImageRemoval };
