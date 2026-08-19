# Get Margin

## Requirements

- Node.js `>=22`
- pnpm `9.15.0`

This repo is a pnpm workspace. Install dependencies from the repository root:

```bash
pnpm install
```

## Development

Run the web app development server:

```bash
pnpm --filter @margin/web dev
```

You can also run the same command from the app directory:

```bash
cd apps/web
pnpm dev
```

Vite will print the local URL in the terminal, usually `http://localhost:5173/`.

## Available Commands

Run these from the repository root unless noted otherwise.

### Root workspace

```bash
pnpm test
pnpm test:watch
pnpm test:golden:update
pnpm typecheck
```

### Web app

```bash
pnpm --filter @margin/web dev
pnpm --filter @margin/web build
pnpm --filter @margin/web preview
pnpm --filter @margin/web typecheck
pnpm --filter @margin/web e2e
pnpm --filter @margin/web fonts:fetch
```

### PDF core package

```bash
pnpm --filter @margin/pdf-core fixtures
```

## Common Test Flow

```bash
pnpm typecheck
pnpm test
pnpm --filter @margin/web build
```
