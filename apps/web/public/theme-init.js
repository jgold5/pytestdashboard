// Applies the persisted / system theme before React mounts (avoids a flash).
// Loaded as an external same-origin script to comply with the strict CSP.
(function () {
  var pref = 'system';
  try {
    pref = window.localStorage.getItem('ptd-theme') || 'system';
  } catch (e) {
    /* storage unavailable */
  }
  var dark =
    pref === 'dark' ||
    (pref !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
