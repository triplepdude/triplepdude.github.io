# triplepdude.github.io

A personal site built to earn money: sell services, sell digital products, and
take tips. It's plain Jekyll, which GitHub Pages builds automatically, so you
don't need a server, a database, or a build step.

**Everything you edit is in [`_config.yml`](_config.yml).** Sections with empty
values are hidden, so the site never shows broken or placeholder links.

## Start earning: checklist

1. **Make it reachable.** Set at least one of these under `contact:`:
   - `form_endpoint`: create a free form at [formspree.io](https://formspree.io)
     and paste its URL. Inquiries land in your inbox, and the form asks each
     client for their budget.
   - `email`: shown publicly as a mailto link.
   - `booking_url`: a [Cal.com](https://cal.com) or Calendly link. You can
     charge for calls there.

   Until one is set, every "Hire me" button points to your GitHub profile.
2. **Price your services.** Edit the `services:` list. Add a `price` such as
   `From $500`. For fixed-price packages, create a
   [Stripe Payment Link](https://stripe.com/payments/payment-links) and paste it
   as `link` so clients can pay right away.
3. **Sell a product.** Package something you've already built (a script, a
   template, a guide) on [Gumroad](https://gumroad.com) or
   [Lemon Squeezy](https://lemonsqueezy.com), then add it under `products:`.
4. **Add a tip jar.** Fill in any of `github_sponsors`, `kofi`, `buymeacoffee`,
   or `paypal` under `support:`.
5. **Publish.** In the repository's **Settings → Pages**, set the source to
   **Deploy from a branch → `main` / root**. The site goes live at
   <https://triplepdude.github.io>.
6. **Get traffic.** Link the site from your GitHub profile README, LinkedIn,
   and every project README, and share it wherever your clients spend time.

## Preview locally (optional)

```sh
gem install jekyll -v '~> 3.10' jekyll-seo-tag jekyll-sitemap webrick
jekyll serve
```

Then open <http://localhost:4000>.
