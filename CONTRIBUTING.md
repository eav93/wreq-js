# Contributing

## 🚀 Getting Started

### Prerequisites

- Node.js >= 18
- Rust toolchain (see [docs/BUILD.md](docs/BUILD.md))
- Git

### Development Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Build the project**
   ```bash
   npm run build
   ```

3. **Run tests**
   ```bash
   npm test
   ```

## 🔧 Making Changes

### Branch Naming

Use descriptive branch names:
- `feat/add-websocket-support` - for new features
- `fix/memory-leak-in-request` - for bug fixes
- `docs/update-readme` - for documentation
- `refactor/optimize-loader` - for refactoring
- `test/add-integration-tests` - for tests

### Code Style

Use Prettier for formatting:
```bash
npm run format
```

## 📝 Commit Message Guidelines

Follow [Conventional Commits](https://www.conventionalcommits.org/):

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `ci`: CI configuration changes
- `chore`: Other changes that don't modify src or test files

### Examples

```bash
# Feature
feat(request): add support for HTTP/3

# Bug fix
fix(loader): resolve platform detection on Alpine Linux

# Documentation
docs(readme): add installation instructions for pnpm

# Breaking change
feat(api)!: change request signature to accept options object

BREAKING CHANGE: request() now requires an options object instead of positional arguments
```

## 🧪 Testing

### Writing Tests

- Write tests for all new features
- Update tests when fixing bugs
- Use descriptive test names

```typescript
// Good
test('should load correct binary for macOS ARM64', () => {
  // ...
});

// Bad
test('test1', () => {
  // ...
});
```

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- path/to/test.spec.ts
```

## 🙏 Thank You!

Your contributions make this project better for everyone. Thank you for taking the time to contribute! 🚀
