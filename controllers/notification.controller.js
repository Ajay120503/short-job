const Notification = require('../models/Notification');

// @desc    Get user notifications
// @route   GET /api/notifications
const getNotifications = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const notifications = await Notification.find({ recipient: req.user._id })
      .populate(
        'sender',
        'name profilePic role category institutionName openToOpportunities badges isAdmin isSuperAdmin lastActiveAt activeDays followers profileThemeVariant'
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Notification.countDocuments({ recipient: req.user._id });
    const unreadCount = await Notification.countDocuments({
      recipient: req.user._id,
      isRead: false,
    });

    res.json({
      success: true,
      notifications,
      unreadCount,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Mark all notifications as read
// @route   PUT /api/notifications/read-all
const markAllRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient: req.user._id, isRead: false },
      { isRead: true }
    );

    res.json({ success: true, message: 'All notifications marked as read.' });
  } catch (error) {
    console.error('Mark all read error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Mark all notifications as read, then delete them
// @route   DELETE /api/notifications
const deleteAllNotifications = async (req, res) => {
  try {
    const filter = { recipient: req.user._id };
    const markedRead = await Notification.updateMany(
      { ...filter, isRead: false },
      { isRead: true }
    );
    const deleted = await Notification.deleteMany(filter);

    res.json({
      success: true,
      message: 'All notifications deleted.',
      markedReadCount: markedRead.modifiedCount || 0,
      deletedCount: deleted.deletedCount || 0,
      unreadCount: 0,
    });
  } catch (error) {
    console.error('Delete all notifications error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

// @desc    Delete a notification
// @route   DELETE /api/notifications/:id
const deleteNotification = async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found.' });
    }

    if (notification.recipient.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const wasUnread = !notification.isRead;
    if (wasUnread) {
      notification.isRead = true;
      await notification.save();
    }
    await notification.deleteOne();

    res.json({
      success: true,
      message: 'Notification deleted.',
      wasUnread,
    });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({ message: 'Server error.' });
  }
};

module.exports = {
  getNotifications,
  markAllRead,
  deleteAllNotifications,
  deleteNotification,
};
