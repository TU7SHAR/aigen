// HTML fixtures for crawler tests (no network).

export const STRUCTURED_PRODUCT_HTML = `
<!doctype html><html><head>
<title>Hydrating Serum — Lumière</title>
<link rel="canonical" href="https://shop.example.com/products/hydrating-serum" />
<meta property="og:title" content="Hydrating Serum" />
<meta property="og:image" content="https://cdn.example.com/serum_1200x1200.jpg" />
<meta name="theme-color" content="#C8A96A" />
<script type="application/ld+json">
{
  "@context":"https://schema.org","@type":"Product",
  "name":"Hydrating Serum",
  "brand":{"@type":"Brand","name":"Lumière"},
  "description":"Lightweight hyaluronic acid serum for all-day hydration.",
  "sku":"LM-SER-30",
  "image":["https://cdn.example.com/serum_1600x1600.jpg","https://cdn.example.com/serum-angle_1200x.jpg"],
  "offers":{"@type":"Offer","price":"39.00","priceCurrency":"USD","availability":"https://schema.org/InStock"}
}
</script>
<style>:root{--brand-primary-color:#121212;--accent-color:#C8A96A}</style>
</head><body>
<header class="site-header"><nav class="nav"><a>Home</a><a>Shop</a><a>Account</a></nav>
<img src="https://cdn.example.com/logo.svg" class="logo" alt="Lumière logo"/></header>
<main class="product">
  <h1>Hydrating Serum</h1>
  <div class="product-media gallery">
    <img src="https://cdn.example.com/serum_1600x1600.jpg" srcset="https://cdn.example.com/serum_400x.jpg 400w, https://cdn.example.com/serum_1600x.jpg 1600w"/>
    <img src="https://cdn.example.com/serum-angle_1200x.jpg"/>
    <img src="https://cdn.example.com/icon-star.png" width="24" height="24" alt="rating"/>
  </div>
  <p>Lightweight hyaluronic acid serum for all-day hydration.</p>
  <h2>Benefits</h2>
  <ul><li>Deep 24-hour hydration</li><li>Non-greasy, fast-absorbing</li><li>Suitable for sensitive skin</li></ul>
  <h2>How to use</h2>
  <p>Apply 2-3 drops to clean skin morning and night.</p>
  <img src="https://cdn.example.com/badge-visa.png" width="40" alt="payment"/>
</main>
<footer class="footer"><a>Privacy</a><a>Terms</a><a>Shipping</a>
<p>Free shipping over $50</p><p>Free shipping over $50</p><p>Free shipping over $50</p></footer>
</body></html>`;

export const NO_STRUCTURED_HTML = `
<!doctype html><html><head><title>Cool Mug | ShopCo</title>
<meta name="description" content="A sturdy ceramic mug."/></head><body>
<nav><a>Home</a><a>Shop</a></nav>
<main>
  <h1>Cool Ceramic Mug</h1>
  <img src="https://cdn.shopco.com/mug-main-1000x1000.jpg"/>
  <p>A sturdy 350ml ceramic mug, dishwasher safe.</p>
  <ul><li>350ml capacity</li><li>Dishwasher safe</li></ul>
</main>
<footer><p>© ShopCo</p></footer></body></html>`;

export const DUPLICATE_HEAVY_HTML = `
<!doctype html><html><head><title>Widget</title></head><body>
<nav><a>Shop now</a><a>Shop now</a><a>Shop now</a></nav>
<main><h1>Mega Widget</h1><p>The best widget for your workflow, built to last.</p>
<ul><li>Durable aluminum body</li><li>USB-C</li></ul></main>
<footer><a>Shop now</a><a>Shop now</a><a>Shop now</a>
<p>Sign up for our newsletter</p><p>Sign up for our newsletter</p></footer>
</body></html>`;

export const SAAS_HOMEPAGE_HTML = `
<!doctype html><html><head>
<title>BhavishAI — Personalized AI Astrology</title>
<meta name="description" content="BhavishAI gives you personalized astrology guidance and birth-chart insights powered by AI."/>
<meta property="og:title" content="BhavishAI"/>
<meta property="og:image" content="https://bhavishai.in/assets/hero_1600.jpg"/>
<meta name="theme-color" content="#6D28D9"/>
<style>:root{--brand-primary-color:#6D28D9;--accent-color:#D8B46A}</style>
</head><body>
<header class="site-header"><nav class="nav"><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/get-report">Get report</a><a href="/about">About</a></nav></header>
<main>
  <section class="hero">
    <h1>Your personalized AI astrology guide</h1>
    <p>Get a tailored birth-chart reading and daily guidance in minutes. No appointments, no guesswork.</p>
    <a class="btn cta" style="background:#6D28D9" href="/get-report">Get your report</a>
    <img src="https://bhavishai.in/assets/hero_1600.jpg"/>
  </section>
  <section>
    <h2>What you get</h2>
    <ul><li>Personalized birth chart</li><li>Daily guidance</li><li>Ask a question</li></ul>
  </section>
  <section>
    <h2>How it works</h2>
    <p>Enter your birth details, and our AI builds your personalized chart and insights.</p>
  </section>
</main>
<footer class="footer"><a href="/privacy">Privacy</a><a href="/terms">Terms</a>
<p>© BhavishAI</p></footer>
</body></html>`;

export const SERVICE_HTML = `
<!doctype html><html><head><title>Northside Plumbing — Fast Local Plumbers</title>
<meta name="description" content="Licensed plumbers serving the north side. Book a visit today."/></head><body>
<nav><a href="/">Home</a><a href="/services">Services</a><a href="/contact">Contact us</a></nav>
<main>
  <h1>Fast, reliable local plumbing</h1>
  <p>Our services include leak repair, drain cleaning and water heater installation. Book an appointment and get a quote today.</p>
  <ul><li>Leak repair</li><li>Drain cleaning</li><li>Water heater installation</li></ul>
  <img src="https://northside.example/van_1200.jpg"/>
</main></body></html>`;
