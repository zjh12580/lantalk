/* LanTalk 云端版 · OneSignal Service Worker
 * 必须放在站点根目录（与 index.html 同级），作用域为根 "/"，Web Push 才能生效。
 * 部署方式：把本文件随 cloud/ 一起发布，使其可通过
 *   https://<你的域名>/OneSignalSDKWorker.js  访问到（同源、公开、Content-Type 为 application/javascript）。
 * 本地用 server.js 启动时同理（server.js 会静态托管 cloud/ 下的文件）。
 *
 * 注意：下面 importScripts 的是 OneSignal v16 的 Service Worker 内核地址，不要改成旧版的 OneSignalSDKWorker.js。
 */
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

/* 点击通知时聚焦已打开的聊天页；没有则新开一个窗口跳到首页 */
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cls) {
      for (var i = 0; i < cls.length; i++) {
        if (cls[i].focus) { return cls[i].focus(); }
      }
      if (clients.openWindow) { return clients.openWindow('/'); }
    })
  );
});
