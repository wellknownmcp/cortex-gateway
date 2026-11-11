import { describe, it, expect } from 'vitest';
import {
  isModelVisible,
  parsePublishedUiUri,
  publishUiUri,
  publishedUiMeta,
  republishContents,
  uiStructuredContent,
} from '../mcp-apps';

describe('published view URIs', () => {
  it('ui://<path> of a backend becomes ui://<backendId>/<path>, and parses back exactly', () => {
    expect(publishUiUri('docs', 'ui://preview')).toBe('ui://docs/preview');
    expect(publishUiUri('docs', 'ui://cards/invoice.v2')).toBe('ui://docs/cards/invoice.v2');
    expect(parsePublishedUiUri('ui://docs/preview')).toEqual({ backendId: 'docs', backendUri: 'ui://preview' });
    expect(parsePublishedUiUri('ui://docs/cards/invoice.v2')).toEqual({
      backendId: 'docs',
      backendUri: 'ui://cards/invoice.v2',
    });
  });

  it('refuses what would leave the backend path or is not a ui:// URI', () => {
    for (const uri of [
      'docs://preview',
      'ui://',
      'ui://../secret',
      'ui://a/../b',
      'ui://a/./b',
      'ui://a//b',
      'ui://a/',
      'ui:///a',
      'ui://a?x=1',
      'ui://a#frag',
      'ui://a%2Fb',
      'ui://a b',
      `ui://${'a'.repeat(1100)}`,
    ]) {
      expect(publishUiUri('docs', uri), uri).toBeNull();
    }
    expect(publishUiUri('Docs', 'ui://preview')).toBeNull();
    expect(publishUiUri('do/cs', 'ui://preview')).toBeNull();
  });

  it('parses only what it would have published', () => {
    for (const uri of ['ui://docs', 'ui://docs/', 'ui:///preview', 'ui://docs/../x', 'ui://docs/a%2Fb', 'https://docs/preview']) {
      expect(parsePublishedUiUri(uri), uri).toBeNull();
    }
  });
});

describe('_meta.ui published for a tool', () => {
  it('publishes the URI and keeps a valid visibility', () => {
    expect(publishedUiMeta('docs', { ui: { resourceUri: 'ui://preview', visibility: ['app'] } })).toEqual({
      resourceUri: 'ui://docs/preview',
      visibility: ['app'],
    });
    expect(publishedUiMeta('docs', { ui: { resourceUri: 'ui://preview' } })).toEqual({ resourceUri: 'ui://docs/preview' });
  });

  it('no declaration, or nothing valid in it: no _meta.ui', () => {
    expect(publishedUiMeta('docs', {})).toBeUndefined();
    expect(publishedUiMeta('docs', { ui: {} })).toBeUndefined();
    expect(publishedUiMeta('docs', { ui: { resourceUri: 'ui://../x' } })).toBeUndefined();
    expect(publishedUiMeta('docs', { ui: 'ui://preview' as never })).toBeUndefined();
    expect(publishedUiMeta('docs', { ui: { resourceUri: 42, visibility: ['everyone'] } as never })).toBeUndefined();
  });

  it('an invalid URI drops the URI, not the visibility', () => {
    expect(publishedUiMeta('docs', { ui: { resourceUri: 'ui://../x', visibility: ['app'] } })).toEqual({ visibility: ['app'] });
    expect(publishedUiMeta('docs', { ui: { visibility: ['app'] } })).toEqual({ visibility: ['app'] });
  });

  it('a tool is model-visible unless its visibility leaves the model out', () => {
    expect(isModelVisible('docs', {})).toBe(true);
    expect(isModelVisible('docs', { ui: { resourceUri: 'ui://preview' } })).toBe(true);
    expect(isModelVisible('docs', { ui: { visibility: ['model', 'app'] } })).toBe(true);
    expect(isModelVisible('docs', { ui: { visibility: ['app'] } })).toBe(false);
  });
});

describe('structuredContent', () => {
  it('a plain object, and only for a tool declaring ui', () => {
    const withUi = { ui: { resourceUri: 'ui://preview' } };
    expect(uiStructuredContent(withUi, { a: 1 })).toEqual({ a: 1 });
    expect(uiStructuredContent(withUi, [1, 2])).toBeUndefined();
    expect(uiStructuredContent(withUi, 'text')).toBeUndefined();
    expect(uiStructuredContent(withUi, null)).toBeUndefined();
    expect(uiStructuredContent({}, { a: 1 })).toBeUndefined();
  });
});

describe('republished contents', () => {
  it('rewrites the backend URI, keeps mimeType and _meta, drops unknown fields', () => {
    const contents = [
      {
        uri: 'ui://preview',
        mimeType: 'text/html;profile=mcp-app',
        text: '<html></html>',
        _meta: { ui: { csp: { connectDomains: ['https://api.example'] } } },
        extra: 'dropped',
      },
    ];
    expect(republishContents(contents as never, 'ui://preview', 'ui://docs/preview')).toEqual([
      {
        uri: 'ui://docs/preview',
        mimeType: 'text/html;profile=mcp-app',
        text: '<html></html>',
        _meta: { ui: { csp: { connectDomains: ['https://api.example'] } } },
      },
    ]);
  });

  it('tolerates a backend answering without contents', () => {
    expect(republishContents(undefined, 'ui://a', 'ui://docs/a')).toEqual([]);
    expect(republishContents('nope' as never, 'ui://a', 'ui://docs/a')).toEqual([]);
  });
});
