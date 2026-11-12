/**
 * APEX ACADEMY — Main Script
 * Handles global interactions, mobile navigation, scroll reveal animations,
 * count-up statistics, interactive FAQ accordions, testimonial slider,
 * back-to-top button, and toast notifications.
 */

document.addEventListener('DOMContentLoaded', () => {
  initNavbar();
  initMobileMenu();
  initCounters();
  initScrollAnimations();
  initActiveNavLink();
  initBackToTop();
  initFaqAccordions();
  initTestimonialSliders();
});

/**
 * Sticky Navbar styling on scroll
 */
function initNavbar() {
  const navbar = document.getElementById('main-navbar');
  if (!navbar) return;

  const handleScroll = () => {
    if (window.scrollY > 30) {
      navbar.classList.add('shadow-md', 'bg-white/95', 'backdrop-blur-md');
      navbar.classList.remove('bg-white/90');
    } else {
      navbar.classList.remove('shadow-md', 'bg-white/95');
      navbar.classList.add('bg-white/90');
    }
  };

  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();
}

/**
 * Mobile Navigation Drawer Toggle
 */
function initMobileMenu() {
  const menuBtn = document.getElementById('mobile-menu-btn');
  const closeBtn = document.getElementById('mobile-close-btn');
  const drawer = document.getElementById('mobile-drawer');
  const backdrop = document.getElementById('mobile-backdrop');

  if (!menuBtn || !drawer) return;

  const openDrawer = () => {
    drawer.classList.remove('translate-x-full');
    drawer.classList.add('translate-x-0');
    if (backdrop) {
      backdrop.classList.remove('opacity-0', 'pointer-events-none');
      backdrop.classList.add('opacity-100', 'pointer-events-auto');
    }
    document.body.style.overflow = 'hidden';
  };

  const closeDrawer = () => {
    drawer.classList.add('translate-x-full');
    drawer.classList.remove('translate-x-0');
    if (backdrop) {
      backdrop.classList.add('opacity-0', 'pointer-events-none');
      backdrop.classList.remove('opacity-100', 'pointer-events-auto');
    }
    document.body.style.overflow = '';
  };

  menuBtn.addEventListener('click', openDrawer);
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
  if (backdrop) backdrop.addEventListener('click', closeDrawer);

  const mobileLinks = drawer.querySelectorAll('a');
  mobileLinks.forEach(link => {
    link.addEventListener('click', closeDrawer);
  });
}

/**
 * Highlight active page in navigation
 */
function initActiveNavLink() {
  const currentPath = window.location.pathname.split('/').pop() || 'index.html';
  const navLinks = document.querySelectorAll('.nav-link');

  navLinks.forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPath || (currentPath === '' && href === 'index.html')) {
      link.classList.add('active');
    }
  });
}

/**
 * Animated Number Counters (Modification 4)
 * Smooth count-up animations for statistics triggered on viewport intersection.
 */
function initCounters() {
  const counterElements = document.querySelectorAll('[data-counter-target]');
  if (!counterElements.length) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const el = entry.target;
        obs.unobserve(el);

        const target = parseFloat(el.getAttribute('data-counter-target'));
        const prefix = el.getAttribute('data-counter-prefix') || '';
        const suffix = el.getAttribute('data-counter-suffix') || '';
        const decimals = parseInt(el.getAttribute('data-counter-decimals') || '0', 10);
        const delay = parseInt(el.getAttribute('data-counter-delay') || '350', 10);
        const duration = parseInt(el.getAttribute('data-counter-duration') || '1800', 10);

        if (prefersReducedMotion || isNaN(target)) {
          el.textContent = `${prefix}${target.toFixed(decimals)}${suffix}`;
          el.classList.add('stat-completed');
          return;
        }

        // Initialize at 0
        el.textContent = `${prefix}${(0).toFixed(decimals)}${suffix}`;

        setTimeout(() => {
          el.classList.add('is-counting');
          const startTime = performance.now();

          const updateCount = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            // Smooth ease-out curve
            const easeProgress = 1 - Math.pow(1 - progress, 3.5);
            const currentValue = target * easeProgress;

            el.textContent = `${prefix}${currentValue.toFixed(decimals)}${suffix}`;

            if (progress < 1) {
              requestAnimationFrame(updateCount);
            } else {
              el.textContent = `${prefix}${target.toFixed(decimals)}${suffix}`;
              el.classList.remove('is-counting');
              el.classList.add('stat-completed');
            }
          };

          requestAnimationFrame(updateCount);
        }, delay);
      }
    });
  }, { threshold: 0.15 });

  counterElements.forEach(el => observer.observe(el));
}

/**
 * Scroll Reveal Animations (IntersectionObserver)
 */
function initScrollAnimations() {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealElements = document.querySelectorAll('.reveal-on-scroll');
  if (!revealElements.length) return;

  if (prefersReducedMotion) {
    revealElements.forEach(el => el.classList.add('is-revealed'));
    return;
  }

  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-revealed');
        obs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  revealElements.forEach(el => observer.observe(el));
}

/**
 * Back to Top Button
 */
function initBackToTop() {
  let btn = document.getElementById('back-to-top-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'back-to-top-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Back to top');
    btn.className = 'fixed bottom-6 right-6 z-40 bg-slate-900 text-white p-3 rounded-full shadow-xl opacity-0 pointer-events-none hover:bg-amber-600 transition-all duration-300 hover-lift border border-slate-700';
    btn.innerHTML = `
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 15l7-7 7 7"/>
      </svg>
    `;
    document.body.appendChild(btn);
  }

  window.addEventListener('scroll', () => {
    if (window.scrollY > 400) {
      btn.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-4');
      btn.classList.add('opacity-100', 'pointer-events-auto', 'translate-y-0');
    } else {
      btn.classList.add('opacity-0', 'pointer-events-none', 'translate-y-4');
      btn.classList.remove('opacity-100', 'pointer-events-auto', 'translate-y-0');
    }
  }, { passive: true });

  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

/**
 * FAQ Accordion Controller
 */
function initFaqAccordions() {
  const accordionItems = document.querySelectorAll('.faq-accordion-item');
  if (!accordionItems.length) return;

  accordionItems.forEach(item => {
    const btn = item.querySelector('.faq-accordion-btn');
    const content = item.querySelector('.faq-accordion-content');
    if (!btn || !content) return;

    btn.addEventListener('click', () => {
      const isActive = item.classList.contains('active');

      // Optionally close other items in the same container
      const parent = item.closest('.faq-accordion-container');
      if (parent) {
        parent.querySelectorAll('.faq-accordion-item').forEach(other => {
          if (other !== item) {
            other.classList.remove('active');
            const otherContent = other.querySelector('.faq-accordion-content');
            if (otherContent) otherContent.style.maxHeight = null;
          }
        });
      }

      if (isActive) {
        item.classList.remove('active');
        content.style.maxHeight = null;
      } else {
        item.classList.add('active');
        content.style.maxHeight = content.scrollHeight + 'px';
      }
    });
  });
}

/**
 * Testimonial Slider / Tab Navigation
 */
function initTestimonialSliders() {
  const slider = document.querySelector('.testimonial-slider');
  if (!slider) return;

  const slides = slider.querySelectorAll('.testimonial-slide');
  const prevBtn = slider.querySelector('.slider-prev');
  const nextBtn = slider.querySelector('.slider-next');
  const dotsContainer = slider.querySelector('.slider-dots');
  if (!slides.length) return;

  let currentIndex = 0;

  // Build dots
  if (dotsContainer) {
    dotsContainer.innerHTML = '';
    slides.forEach((_, i) => {
      const dot = document.createElement('button');
      dot.className = `w-2.5 h-2.5 rounded-full transition-all ${i === 0 ? 'bg-amber-600 w-6' : 'bg-slate-300'}`;
      dot.addEventListener('click', () => showSlide(i));
      dotsContainer.appendChild(dot);
    });
  }

  function showSlide(index) {
    if (index < 0) index = slides.length - 1;
    if (index >= slides.length) index = 0;
    currentIndex = index;

    slides.forEach((slide, i) => {
      if (i === currentIndex) {
        slide.classList.remove('hidden');
        slide.classList.add('block');
      } else {
        slide.classList.add('hidden');
        slide.classList.remove('block');
      }
    });

    if (dotsContainer) {
      const dots = dotsContainer.querySelectorAll('button');
      dots.forEach((dot, i) => {
        if (i === currentIndex) {
          dot.className = 'w-6 h-2.5 rounded-full bg-amber-600 transition-all';
        } else {
          dot.className = 'w-2.5 h-2.5 rounded-full bg-slate-300 transition-all';
        }
      });
    }
  }

  if (prevBtn) prevBtn.addEventListener('click', () => showSlide(currentIndex - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => showSlide(currentIndex + 1));

  showSlide(0);
}

/**
 * Global Toast Notification Helper
 */
window.showToast = function(title, message, type = 'success') {
  let toastContainer = document.getElementById('toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.className = 'fixed bottom-5 right-5 z-50 flex flex-col gap-3 max-w-md w-full px-4 pointer-events-none';
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  toast.className = `pointer-events-auto transform transition-all duration-300 ease-out translate-y-4 opacity-0 flex items-start p-4 rounded-xl shadow-2xl border ${
    type === 'success' 
      ? 'bg-slate-900 text-white border-emerald-500/30' 
      : 'bg-red-900 text-white border-red-500/30'
  }`;

  const iconSvg = type === 'success' 
    ? `<div class="w-8 h-8 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0 mr-3 mt-0.5">
         <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>
       </div>`
    : `<div class="w-8 h-8 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center shrink-0 mr-3 mt-0.5">
         <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
       </div>`;

  toast.innerHTML = `
    ${iconSvg}
    <div class="flex-1">
      <h4 class="font-semibold text-sm text-white">${title}</h4>
      <p class="text-xs text-slate-300 mt-0.5 leading-relaxed">${message}</p>
    </div>
    <button class="text-slate-400 hover:text-white ml-2 text-sm" onclick="this.parentElement.remove()">✕</button>
  `;

  toastContainer.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-4', 'opacity-0');
    toast.classList.add('translate-y-0', 'opacity-100');
  });

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 5000);
};
