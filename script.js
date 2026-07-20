(function(){
  "use strict";

  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebarOverlay');
  var hamburger = document.getElementById('hamburgerBtn');

  function openSidebar(){
    sidebar.classList.add('open');
    overlay.classList.add('show');
    hamburger.classList.add('open');
    hamburger.setAttribute('aria-expanded','true');
  }
  function closeSidebar(){
    sidebar.classList.remove('open');
    overlay.classList.remove('show');
    hamburger.classList.remove('open');
    hamburger.setAttribute('aria-expanded','false');
  }
  if(hamburger){
    hamburger.addEventListener('click', function(){
      if(sidebar.classList.contains('open')){ closeSidebar(); } else { openSidebar(); }
    });
  }
  if(overlay){ overlay.addEventListener('click', closeSidebar); }

  // Close mobile drawer after a nav link is tapped
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('#tocNav a'));
  tocLinks.forEach(function(link){
    link.addEventListener('click', function(){
      if(window.matchMedia('(max-width: 880px)').matches){ closeSidebar(); }
    });
  });

  // Scrollspy via IntersectionObserver
  var sections = Array.prototype.slice.call(document.querySelectorAll('.part'));
  var linkMap = {};
  tocLinks.forEach(function(link){
    var id = link.getAttribute('href').replace('#','');
    linkMap[id] = link;
  });

  function setActive(id){
    tocLinks.forEach(function(l){ l.classList.remove('active'); });
    if(linkMap[id]){
      linkMap[id].classList.add('active');
      // keep active link visible within the scrollable sidebar
      var rect = linkMap[id].getBoundingClientRect();
      var sbRect = sidebar.getBoundingClientRect();
      if(rect.top < sbRect.top || rect.bottom > sbRect.bottom){
        linkMap[id].scrollIntoView({block:'nearest'});
      }
    }
  }

  if('IntersectionObserver' in window){
    var observer = new IntersectionObserver(function(entries){
      var visible = entries.filter(function(e){ return e.isIntersecting; });
      if(visible.length > 0){
        visible.sort(function(a,b){ return b.intersectionRatio - a.intersectionRatio; });
        setActive(visible[0].target.id);
      }
    }, { rootMargin: '-15% 0px -55% 0px', threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
    sections.forEach(function(sec){ observer.observe(sec); });
  }

  // Print button
  var printBtn = document.getElementById('printBtn');
  if(printBtn){ printBtn.addEventListener('click', function(){ window.print(); }); }

  // Back to top
  var backToTop = document.getElementById('backToTop');
  window.addEventListener('scroll', function(){
    if(window.scrollY > 600){ backToTop.classList.add('show'); }
    else { backToTop.classList.remove('show'); }
  }, { passive:true });
  backToTop.addEventListener('click', function(){
    window.scrollTo({top:0, behavior:'smooth'});
  });

  // Respect reduced motion
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){
    document.documentElement.style.scrollBehavior = 'auto';
  }
})();