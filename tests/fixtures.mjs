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
