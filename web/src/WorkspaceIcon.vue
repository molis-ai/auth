<script setup lang="ts">
defineProps<{ name: string }>()
const paths: Record<string, string> = {
  language: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18',
  permissions: 'M4 3h16v18H4zM8 8h2M14 8h2M8 12h2M14 12h2M8 16l2 2 5-5',
  pending: 'M5 3h14v18H5zM9 8h6M9 12h6M9 16h3',
  account: 'M20 21v-2a7 7 0 0 0-14 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  security: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6zM9 12l2 2 4-4',
  spaces: 'M3 7h7l2 2h9v11H3zM3 7V4h7l2 3',
  applications: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  users: 'M16 21v-2a5 5 0 0 0-10 0v2M11 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M20 21v-2a5 5 0 0 0-3-4M17 3a4 4 0 0 1 0 8',
  audit: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  mail: 'M3 5h18v14H3zM3 5l9 7 9-7',
  menu: 'M4 6h16M4 12h16M4 18h16',
  collapse: 'M9 3H3v18h6M15 8l-4 4 4 4M11 12h10',
  expand: 'M9 3H3v18h6M15 8l4 4-4 4M9 12h10',
  close: 'M6 6l12 12M18 6 6 18',
}
</script>
<template><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.account" /></svg></template>
