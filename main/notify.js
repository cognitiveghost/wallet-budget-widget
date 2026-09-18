const { Notification } = require('electron');

function fire(alerts) {
  for (const a of alerts) {
    if (!Notification.isSupported()) return;
    new Notification({ title: a.title, body: a.body }).show();
  }
}

module.exports = { fire };
