# shop-web

- Orders move from draft to paid to shipped; only the backend changes an order's state.
- Use pnpm, not npm, for every install.
- Browser storage only through `src/shared/storage.ts` (`readSetting`, `writeSetting`), never `localStorage` or `sessionStorage` directly.
