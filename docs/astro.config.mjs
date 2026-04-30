// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function remarkMermaid() {
  return (tree) => {
    const walk = (node, parent, index) => {
      if (node.type === 'code' && node.lang === 'mermaid' && parent) {
        parent.children[index] = {
          type: 'html',
          value: `<pre class="mermaid">${escapeHtml(node.value ?? '')}</pre>`,
        };
        return;
      }
      if (Array.isArray(node.children)) {
        node.children.forEach((child, i) => walk(child, node, i));
      }
    };
    walk(tree, null, -1);
  };
}

export default defineConfig({
  site: 'https://x1agent.com',
  markdown: {
    remarkPlugins: [remarkMermaid],
  },
  integrations: [
    starlight({
      title: 'x1agent docs',
      // Force dark-only theme — marketing site is dark, docs match.
      // The light mode toggle is also hidden in theme.css.
      defaultLocale: 'en',
      customCss: ['./src/styles/theme.css'],
      components: {
        Head: './src/components/Head.astro',
      },
      head: [
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://rsms.me/' },
        },
        {
          tag: 'link',
          attrs: { rel: 'stylesheet', href: 'https://rsms.me/inter/inter.css' },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap',
          },
        },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          autogenerate: { directory: 'getting-started' },
        },
        {
          label: 'Architecture',
          autogenerate: { directory: 'architecture' },
        },
        {
          label: 'Providers',
          autogenerate: { directory: 'providers' },
        },
        {
          label: 'Security',
          autogenerate: { directory: 'security' },
        },
        {
          label: 'Configuration',
          autogenerate: { directory: 'configuration' },
        },
        {
          label: 'Deployment',
          autogenerate: { directory: 'deployment' },
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'reference' },
        },
        {
          label: 'Proposals',
          autogenerate: { directory: 'proposals' },
        },
      ],
    }),
  ],
});
