# TripleP Tools

A collection of free, fast, private tools that run entirely in the browser, published at
<https://triplepdude.github.io>. It's a static Jekyll site: GitHub Pages builds and hosts it,
and there is no server, database, or account system to maintain.

## What runs by itself

- **Hosting and deploys.** Every push to `main` is published by GitHub Pages.
- **Search discovery.** `/sitemap.xml` and `/robots.txt` are generated automatically. The
  [IndexNow workflow](.github/workflows/indexnow.yml) notifies Bing, Yandex, Seznam, Naver and
  other IndexNow engines after each deploy.
- **Ads.** Off until you add an ad ID. After that, the code on every page and `/ads.txt` are
  generated from [`_config.yml`](_config.yml), and the [privacy policy](privacy.md) updates its
  advertising section to match.

## Earning from it

No ad network pays a brand-new site automatically. Each one needs a one-time signup in your
name, and the good ones only approve sites that already have content and traffic. The site is
built to pass that review: every tool page has original how-to content, a FAQ, and a privacy
policy. The realistic path:

1. **Now: nothing required.** Let search engines find the site. New sites usually see little
   traffic for the first few months.
2. **Optional, 5 minutes, once:** add the site as a URL-prefix property in
   [Google Search Console](https://search.google.com/search-console) and submit
   `https://triplepdude.github.io/sitemap.xml`. Google finds new sites mainly through links, so
   this can bring search traffic much sooner. For verification, uncomment
   `webmaster_verifications` in `_config.yml` and paste the code.
3. **Once there's steady traffic, apply to [Google AdSense](https://adsense.google.com).** Choose
   "I don't have a site yet" at signup, then add `triplepdude.github.io` under Sites. Paste your
   `ca-pub-…` ID into `ads.adsense_client` in `_config.yml`, which adds the AdSense script and
   `ads.txt`, and request review. When asked, pick Google's own consent message for EU/UK
   visitors. Google also asks for a one-time ID check, a PIN sent by post once earnings reach
   $10, and tax/payment details. After that, payouts are automatic above $100. An AdSense
   account with no ad impressions for six months is deactivated, so apply when traffic exists,
   not before.
4. **At about 50,000 page views a month:** [EthicalAds](https://www.ethicalads.io/publishers/)
   is a privacy-friendly alternative that suits developer tools. Set
   `ads.ethicalads_publisher`; it replaces AdSense, because it must be the only ad on a page.
5. **Any time:** set `support_url` to a GitHub Sponsors or Ko-fi page to show a small "Support
   this site" link in the footer.

Expect modest income. Display ads on a tools site typically pay a few dollars per thousand page
views.

**GitHub Pages terms.** GitHub's
[Pages terms](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
don't allow using Pages to run an online business or e-commerce site, and the
[Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies#10-advertising-on-github)
say the primary focus of content must not be advertising. Donation links are explicitly
allowed. Modest, non-intrusive display ads next to genuinely useful tools are a gray area that
GitHub doesn't address directly. Keep the tools the point of every page: no pop-ups, no
redirects, no ad-heavy layouts. If the site grows large, moving it to a host that explicitly
allows commercial use (it's plain static files) removes that question entirely.

## Adding or changing a tool

Each tool is one file in [`_tools/`](_tools) with a matching test in [`tests/tools/`](tests/tools).
Copy [`_tools/word-counter.html`](_tools/word-counter.html) as a starting point. Its front matter
holds the title, meta description, category, how-to text and FAQ, and the body holds the tool's
HTML and JavaScript. The homepage, related-tool links, structured data and sitemap pick up new
tools automatically.

Rules the test runner enforces: no requests to other hosts (third-party libraries are vendored in
`assets/vendor/`), no JavaScript errors, a proper title and description, and no horizontal
scrolling on phones.

```sh
gem install jekyll -v '~> 3.10' jekyll-seo-tag jekyll-sitemap webrick
npm install
npm test                      # every tool
node tests/run.js word-counter  # just one
jekyll serve                  # preview at http://localhost:4000
```
