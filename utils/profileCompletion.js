const MANDATORY_FIELDS = ['name', 'age', 'profilePic', 'address.city'];

const getProfileCompletionStatus = (user) => {
  const present = {
    name: Boolean(user?.name?.trim?.()),
    age: Number.isFinite(Number(user?.age)),
    profilePic: Boolean(user?.profilePic?.url || user?.profilePic),
    'address.city': Boolean(user?.address?.city || user?.city),
  };
  const missingMandatory = MANDATORY_FIELDS.filter((field) => !present[field]);
  return { isComplete: missingMandatory.length === 0, missingMandatory };
};

module.exports = { MANDATORY_FIELDS, getProfileCompletionStatus };
