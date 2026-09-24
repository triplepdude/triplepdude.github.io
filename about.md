---
layout: page
title: About
description: Who runs TripleP Tools, what the free tools do, how each one is tested, and how to get in touch. Every tool runs entirely in your browser.
permalink: /about/
schema_type: AboutPage
last_modified_at: 2026-09-24
---
{%- assign ea = site.ads.ethicalads_publisher | default: "" | strip -%}
{%- assign adsense = site.ads.adsense_client | default: "" | strip -%}
{%- assign support = site.support_url | default: "" | strip -%}
{%- assign used = site.tools | map: "category" | uniq | sort -%}
{%- assign categories = "" | split: "" -%}
{%- for c in site.data.categories -%}{%- if used contains c -%}{%- assign categories = categories | push: c -%}{%- endif -%}{%- endfor -%}
{%- for c in used -%}{%- unless categories contains c -%}{%- assign categories = categories | push: c -%}{%- endunless -%}{%- endfor -%}
{%- assign repo = "https://github.com/" | append: site.github_username | append: "/" | append: site.github_username | append: ".github.io" %}

TripleP Tools is a collection of {{ site.tools.size }} small, free utilities
for everyday tasks and for developers. It is an independent project, maintained
by [{{ site.github_username }}](https://github.com/{{ site.github_username }})
on GitHub, where the site's [source code]({{ repo }}) is public.

The aim is tools that do one job well without asking anything of you: no
account, no uploads, and no watermarks. Many free online tools send
your files to a server to process them. Every tool here does its work on your
own device instead, and each one comes with a short guide to the standard or
format behind it, so you can check the result rather than just trust it.

## What's here

{% for cat in categories -%}
{%- assign in_cat = site.tools | where: "category", cat %}
- [{{ cat }}]({{ '/' | relative_url }}#{{ cat | slugify }}): {{ in_cat.size }} {% if in_cat.size == 1 %}tool{% else %}tools{% endif %}
{%- endfor %}

These include image and PDF tools, text utilities, developer helpers, date and
time converters, generators, and device tests for your webcam, microphone, and
keyboard.

## Everything runs in your browser

The tools are plain JavaScript that runs on your own device. Text you paste,
files you open, and numbers you enter are never uploaded to a server, and the
tools keep nothing once you close the page. The
[privacy policy]({{ '/privacy/' | relative_url }}) has the details.

## How the tools are tested

Each tool has an automated test that opens it in a real browser (Chromium,
driven by [Playwright](https://playwright.dev/)), gives it known inputs, and
checks the results. The same test run fails if a page shows a JavaScript error,
makes a request to another server, or scrolls sideways on a phone-sized screen.

## How the site is paid for

{% if ea != "" or adsense != "" -%}
The site is kept free by advertising, described in the
[privacy policy]({{ '/privacy/' | relative_url }}#advertising). Ads never block
a tool, and the tools work the same with an ad blocker.
{%- else -%}
The site is currently ad-free. If advertising is ever added to cover its costs,
the [privacy policy]({{ '/privacy/' | relative_url }}#advertising) will describe
it before any ads appear.
{%- endif %}
{%- if support != "" %} You can also [support the site]({{ support }}) directly.{% endif %}

## Contact

Found a bug, have a question, or want a tool that isn't here? Open an
[issue on GitHub]({{ repo }}/issues). You need a free GitHub account to post
one.
