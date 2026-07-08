'use strict';

/**
 * Crowsnest static portal HTML (skeleton — no writes, no API calls).
 */

function renderCrowsnestPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Crowsnest</title>
  <style>
    :root { font-family: system-ui, sans-serif; color: #1a1a1a; background: #f4f6f8; }
    body { margin: 0; padding: 2rem; }
    .wrap { max-width: 720px; margin: 0 auto; }
    h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
    .sub { color: #555; margin: 0 0 1.5rem; }
    .cards { display: grid; gap: 0.75rem; }
    .card {
      background: #fff; border: 1px solid #dde3ea; border-radius: 8px;
      padding: 1rem 1.25rem;
    }
    .card h2 { margin: 0 0 0.35rem; font-size: 1rem; }
    .card p { margin: 0; color: #666; font-size: 0.9rem; }
    .badge { display: inline-block; font-size: 0.75rem; color: #888; margin-top: 0.35rem; }
    .safety {
      margin-top: 1.5rem; padding: 0.75rem 1rem; background: #fff8e6;
      border: 1px solid #f0d78c; border-radius: 8px; font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Crowsnest</h1>
    <p class="sub">Internal Luna Front Desk control portal</p>
    <div class="cards">
      <div class="card">
        <h2>Client onboarding</h2>
        <p>Onboard and manage Luna Front Desk clients from one place.</p>
        <span class="badge">Coming soon</span>
      </div>
      <div class="card">
        <h2>Surf house template</h2>
        <p>Start a new surf house / lodging client from a template.</p>
        <span class="badge">Coming soon</span>
      </div>
      <div class="card">
        <h2>Surf school template</h2>
        <p>Start a new surf school / rentals client from a template.</p>
        <span class="badge">Coming soon</span>
      </div>
      <div class="card">
        <h2>Environments / status</h2>
        <p>Staging and tenant runtime overview.</p>
        <span class="badge">Coming soon</span>
      </div>
    </div>
    <div class="safety"><strong>Safety:</strong> no writes enabled — skeleton only.</div>
  </div>
</body>
</html>`;
}

module.exports = {
  renderCrowsnestPage,
};
