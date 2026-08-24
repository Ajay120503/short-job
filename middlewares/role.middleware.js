const roleMiddleware = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authenticated.' });
    }

    const activeBadges = (req.user.badges || [])
      .filter((badge) => badge.isActive !== false)
      .map((badge) => badge.type);

    const legacyRole = req.user.role || req.user.category;
    const categoryRoleMap = {
      school: ['teacher', 'school_member'],
      college: ['professor', 'college_member'],
      student: ['student'],
    };
    const institutionRoles = ['teacher', 'professor', 'hod', 'principal'];
    const institutionBadges = [
      'teacher',
      'professor',
      'hod',
      'principal',
      'lecturer',
      'school_member',
      'college_member',
      'university_member',
      'coaching_member',
    ];
    const derivedRoles = [
      legacyRole,
      ...activeBadges,
      ...(categoryRoleMap[req.user.category] || []),
    ].filter(Boolean);

    const hasRequiredRole = roles.some((role) => derivedRoles.includes(role));
    const institutionRoleRequested = roles.some((role) => institutionRoles.includes(role));
    const onlyInstitutionRolesRequested = roles.every((role) => institutionRoles.includes(role));
    const hasInstitutionBadge = institutionBadges.some((badge) => derivedRoles.includes(badge));

    // Job/story creation is now open to all signed-in users. Keep this
    // compatibility path for any legacy route still using institution roles.
    if (onlyInstitutionRolesRequested) {
      return next();
    }

    if (!hasRequiredRole && !(institutionRoleRequested && hasInstitutionBadge)) {
      return res.status(403).json({
        message: `Access denied. Required role: ${roles.join(' or ')}`,
      });
    }

    next();
  };
};

const isAdminAccount = (user) => Boolean(user?.isAdmin || user?.isSuperAdmin);
const isSuperAdminAccount = (user) => Boolean(user?.isSuperAdmin);

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
