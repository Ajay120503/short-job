const isAdminAccount = (user) => Boolean(user?.isAdmin || user?.isSuperAdmin);
const isSuperAdminAccount = (user) => Boolean(user?.isSuperAdmin);

const roleMiddleware = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authenticated.' });
    }

    if (roles.includes('super_admin') || roles.includes('superAdmin')) {
      if (!isSuperAdminAccount(req.user)) {
        return res.status(403).json({ message: 'Access denied. Super admin only.' });
      }
      return next();
    }

    if (roles.includes('admin')) {
      if (!isAdminAccount(req.user)) {
        return res.status(403).json({ message: 'Access denied. Admin only.' });
      }
      return next();
    }

    return next();
  };
};

const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authenticated.' });
  }

  if (!isAdminAccount(req.user)) {
    return res.status(403).json({ message: 'Access denied. Admin only.' });
  }

  next();
};

const requireSuperAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authenticated.' });
  }

  if (!isSuperAdminAccount(req.user)) {
    return res.status(403).json({ message: 'Access denied. Super admin only.' });
  }

  next();
};

module.exports = roleMiddleware;
module.exports.isAdminAccount = isAdminAccount;
module.exports.isSuperAdminAccount = isSuperAdminAccount;
module.exports.requireAdmin = requireAdmin;
module.exports.requireSuperAdmin = requireSuperAdmin;
