const fs = require('fs');
const path = require('path');

const cssPath = path.resolve(__dirname, '..', 'admin', 'css', 'admin.css');
let css = fs.readFileSync(cssPath, 'utf8');

// Section 1: Login mobile padding
const s1 = `.login-form-side {
  width: 100%;
  max-width: 520px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  position: relative;
  z-index: 2;
}

@media (min-width: 1024px) {
  .login-form-side {
    background: var(--admin-surface);
    border-left: 1px solid var(--admin-border);
    min-height: 100vh;
  }
}

.login-card {
  width: 100%;
  max-width: 400px;
}

@media (max-width: 1023px) {
  .login-card {
    background: var(--admin-surface);
    border-radius: 1.25rem;
    padding: 2rem;
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
  }
}`;

const r1 = `.login-form-side {
  width: 100%;
  max-width: 520px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  position: relative;
  z-index: 2;
}

@media (min-width: 1024px) {
  .login-form-side {
    background: var(--admin-surface);
    border-left: 1px solid var(--admin-border);
    min-height: 100vh;
  }
}

@media (max-width: 480px) {
  .login-form-side {
    padding: 1.25rem 0.75rem;
  }
}

.login-card {
  width: 100%;
  max-width: 400px;
}

@media (max-width: 1023px) {
  .login-card {
    background: var(--admin-surface);
    border-radius: 1.25rem;
    padding: 2rem;
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
  }
}

@media (max-width: 480px) {
  .login-card {
    padding: 1.25rem 1rem !important;
    border-radius: 1rem;
  }
}`;

// Section 2: Data Table sticky first column
const s2 = `/* ─── DATA TABLE ─── */
.data-table-wrapper {
  overflow-x: auto;
}

.data-table {`;

const r2 = `/* ─── DATA TABLE ─── */
.data-table-wrapper {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scroll-behavior: smooth;
}

@media (max-width: 1023px) {
  .data-table thead th:first-child {
    position: sticky;
    left: 0;
    z-index: 5;
    background: #F8FAFC;
    box-shadow: 2px 0 4px -2px rgba(0,0,0,0.1);
  }
  .data-table tbody td:first-child {
    position: sticky;
    left: 0;
    z-index: 4;
    background: #FFFFFF;
    box-shadow: 2px 0 4px -2px rgba(0,0,0,0.1);
  }
  .data-table tbody tr:hover td:first-child {
    background: #F8FAFC;
  }
}

.data-table {`;

// Section 3: Detail row mobile stacking
const s3 = `.detail-row-value {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--admin-text);
  text-align: right;
  word-break: break-word;
}`;

const r3 = `.detail-row-value {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--admin-text);
  text-align: right;
  word-break: break-word;
}

@media (max-width: 480px) {
  .detail-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.2rem;
  }
  .detail-row-label {
    min-width: 0;
  }
  .detail-row-value {
    text-align: left;
  }
  .drawer-header {
    padding: 1rem 1rem;
  }
  .drawer-body {
    padding: 1rem 1rem;
  }
  .drawer-footer {
    padding: 0.75rem 1rem;
  }
}`;

// Section 4: Topbar title & Tablet filter-bar
const s4 = `@media (max-width: 640px) {
  .stat-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .stat-card-value {
    font-size: 1.375rem;
  }
  
  .admin-card-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .filter-bar {
    flex-direction: column;
  }

  .search-input-wrapper {
    max-width: 100%;
  }

  .topbar-actions {
    gap: 0.375rem;
  }
}`;

const r4 = `@media (max-width: 640px) {
  .admin-topbar {
    padding: 0 0.75rem;
    gap: 0.5rem;
  }

  .topbar-title {
    font-size: 0.9375rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: calc(100vw - 195px);
  }

  .topbar-breadcrumb {
    display: none;
  }

  .topbar-actions {
    gap: 0.35rem;
  }

  .admin-content {
    padding: 1rem 0.75rem;
  }

  .stat-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .stat-card-value {
    font-size: 1.375rem;
  }
  
  .admin-card-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .filter-bar {
    flex-direction: column;
  }

  .search-input-wrapper {
    max-width: 100%;
  }
}

@media (min-width: 641px) and (max-width: 860px) {
  .filter-bar {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .search-input-wrapper {
    grid-column: 1 / -1;
    max-width: 100%;
  }
  .filter-select {
    min-width: 0;
    width: 100%;
  }
}`;

function replaceFlexible(content, target, replacement, label) {
  const isCRLF = content.includes('\r\n');
  const actualTarget = isCRLF ? target.replace(/\r?\n/g, '\r\n') : target.replace(/\r\n/g, '\n');
  const actualReplacement = isCRLF ? replacement.replace(/\r?\n/g, '\r\n') : replacement.replace(/\r\n/g, '\n');
  if (!content.includes(actualTarget)) {
    console.error(`[FAIL] ${label} not found`);
    return content;
  }
  console.log(`[OK] ${label}`);
  return content.replace(actualTarget, actualReplacement);
}

css = replaceFlexible(css, s1, r1, 'Login Mobile Padding');
css = replaceFlexible(css, s2, r2, 'Data Table Sticky First Column');
css = replaceFlexible(css, s3, r3, 'Detail Row Mobile Stacking');
css = replaceFlexible(css, s4, r4, 'Topbar Title & Tablet Filter Bar');

fs.writeFileSync(cssPath, css, 'utf8');
console.log('Finished updating admin.css');
