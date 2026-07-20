(function () {
  var els = document.querySelectorAll('[data-animate]');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) {
    els.forEach(function (el) {
      el.classList.add('is-in');
    });
    return;
  }
  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.02 },
  );
  els.forEach(function (el) {
    io.observe(el);
  });
  // Failsafe: never leave content hidden.
  setTimeout(function () {
    document.querySelectorAll('[data-animate]:not(.is-in)').forEach(function (el) {
      el.classList.add('is-in');
    });
  }, 2500);
})();
