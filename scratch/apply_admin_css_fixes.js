const fs = require('fs');
const path = require('path');

const cssPath = path.resolve(__dirname, '..', 'admin', 'css', 'admin.css');
let css = fs.readFileSync(cssPath, 'utf8');

// 1. .login-form-side and .login-card mobile padding
const loginSideSearch = `.login-form-side {
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
}`;

const loginSideReplace = `.login-form-side {
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
}`;

const loginCardSearch = `@media (max-width: 1023px) {
  .login-card {
    background: var(--admin-surface);
    border-radius: 1.25rem;
    padding: 2rem;
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
  }
}`;

const loginCardReplace = `@media (max-width: 1023px) {
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

// 2. Data Table Sticky Column & Smooth Scrolling
const dataTableSearch = `/* ─── DATA TABLE ─── */
.data-table-wrapper {
  overflow-x: auto;
}`;

const dataTableReplace = `/* ─── DATA TABLE ─── */
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
}`;

// 3. Detail row mobile stacking
const detailRowSearch = `.detail-row-value {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--admin-text);
  text-align: right;
  word-break: break-word;
}`;

const detailRowReplace = `.detail-row-value {
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

// 4. Media query max-width: 640px update & min-width: 641px / max-width: 860px for tablet filter-bar
const mq640Search = `@media (max-width: 640px) {
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

const mq640Replace = `@media (max-width: 640px) {
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

// 5. Role card header wrapping & mobile styles
const roleHeaderSearch = `.role-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.25rem;
}`;

const roleHeaderReplace = `.role-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.25rem;
  flex-wrap: wrap;
  gap: 0.25rem;
}

@media (max-width: 480px) {
  .role-card {
    padding: 0.875rem 0.875rem;
    gap: 0.75rem;
  }
  .role-card-icon {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
  }
  .role-card-title {
    font-size: 0.875rem;
  }
  .role-card-badge {
    font-size: 0.5625rem;
    padding: 0.15rem 0.4rem;
  }
}`;

// 6. Tour Popover
const tourPopSearch = `.tour-popover {
  position: fixed;
  z-index: 9990;
  width: 360px;
  max-width: calc(100vw - 32px);
  background: #FFFFFF;
  border-radius: 12px;
  padding: 1.25rem;
  box-shadow: 0 20px 40px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.06);
  transition: all 0.25s ease;
}`;

const tourPopReplace = `.tour-popover {
  position: fixed;
  z-index: 9990;
  width: 360px;
  max-width: calc(100vw - 32px);
  background: #FFFFFF;
  border-radius: 12px;
  padding: 1.25rem;
  box-shadow: 0 20px 40px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.06);
  transition: all 0.25s ease;
}

@media (max-width: 480px) {
  .tour-popover {
    padding: 1rem;
  }
}`;

function doReplace(s, r, name) {
  const normS = s.replace(/\r\n/g, '\n');
  const normCSS = css.replace(/\r\n/g, '\n');
  if (!normCSS.includes(normS)) {
    console.error(`[FAIL] ${name} not found`);
    return false;
  }
  const isCRLF = css.includes('\r\n');
  const actualS = isCRLF ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n');
  const actualR = isCRLF ? r.replace(/\r?\n/g, '\r\n') : r.replace(/\r\n/g, '\n');
  css = css.replace(actualS, actualR);
  console.log(`[OK] ${name}`);
  return true;
}

let ok = true;
ok = doReplace(loginSideSearch, loginSideReplace, 'Login Side Padding') && ok;
ok = doReplace(loginCardSearch, loginCardReplace, 'Login Card Padding') && ok;
ok = doReplace(dataTableSearch, dataTableReplace, 'Data Table Sticky') && ok;
ok = doReplace(detailRowSearch, detailRowReplace, 'Detail Row Stacking') && ok;
ok = doReplace(mq640Search, mq640Replace, 'MQ 640 and Tablet Filter') && ok;
ok = doReplace(roleHeaderSearch, roleHeaderReplace, 'Role Card Header Wrap') && ok;
ok = doReplace(tourPopSearch, tourPopReplace, 'Tour Popover Responsive') && ok;

if (ok) {
  fs.writeFileSync(cssPath, css, 'utf8');
  console.log('Successfully wrote updated admin.css');
} else {
  console.error('Some CSS replacements failed.');
  process.exit(1);
}
