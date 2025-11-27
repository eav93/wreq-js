export const HTTP_TEST_BASE_URL = process.env.HTTP_TEST_BASE_URL;

if (!HTTP_TEST_BASE_URL) {
  throw new Error("HTTP_TEST_BASE_URL environment variable must be set by the test runner");
}

export const httpUrl = (path: string) => new URL(path, HTTP_TEST_BASE_URL).toString();

export function headerIndex(rawHeaders: string[], name: string) {
  return rawHeaders.findIndex((value, index) => index % 2 === 0 && value.toLowerCase() === name.toLowerCase());
}
