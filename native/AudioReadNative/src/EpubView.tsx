import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {StyleSheet, View} from 'react-native';
import {WebView as RNWebView} from 'react-native-webview';

// react-native-webview's published types don't resolve cleanly against React 19's
// stricter JSX class-component typing, so we use it through a loosely typed alias.
const WebView = RNWebView as unknown as React.ComponentType<any>;

type WebViewMessageEvent = {nativeEvent: {data: string}};

type EpubViewProps = {
  html: string;
  baseUrl: string;
  currentIndex: number;
  dark: boolean;
  bg: string;
  fontScale: number;
  lineSpacing: number;
  onSentences: (sentences: string[]) => void;
  onSelectSentence: (index: number) => void;
  onError?: (message: string) => void;
};

// Injected into each chapter once it loads. It wraps every run of text in a span
// tagged with a running sentence index (preserving the original inline markup),
// reports the resulting sentence list to React Native, and exposes a highlight
// helper that React Native calls as the speech progresses.
const buildInjectedScript = (dark: boolean) => `
(function(){
  try {
    if (window.__arReady) { post({type:'sentences', list: window.__arSentences || []}); return true; }
    function post(obj){ window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(obj)); }
    window.__arPost = post;

    // EPUB XHTML usually has no mobile viewport, so the WebView renders it at a wide
    // desktop width and shrinks it -> tiny text. Force a device-width viewport.
    var vp = document.querySelector('meta[name="viewport"]');
    if (!vp) { vp = document.createElement('meta'); vp.setAttribute('name','viewport'); document.head.appendChild(vp); }
    vp.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=4');

    var FG = ${dark} ? '#f4f6f2' : '#1d2423';
    var BG = ${dark} ? '#101312' : '#f6f7f4';
    var LINK = ${dark} ? '#2dd4bf' : '#0f766e';
    var HL_BG = ${dark} ? '#a87a14' : '#ffd24d';
    var HL_FG = ${dark} ? '#0b0b0b' : '#1d2423';
    // Clean "reader mode" typography. The EPUB's own CSS is stripped server-side, so
    // these rules fully control layout -> consistent spacing, single column, no
    // overlapping/absolutely-positioned text.
    var style = document.createElement('style');
    style.textContent = ''
      + 'html{-webkit-text-size-adjust:100%;text-size-adjust:100%;}'
      + '*{position:static !important;float:none !important;max-width:100% !important;'
      + 'box-sizing:border-box !important;}'
      + 'html,body{margin:0 !important;padding:0 !important;background:' + BG + ' !important;}'
      + 'body{padding:20px 22px 200px !important;font-size:1.18rem !important;'
      + 'line-height:1.75 !important;letter-spacing:0;'
      + 'font-family:Georgia,"Times New Roman",serif !important;'
      + 'color:' + FG + ' !important;}'
      + 'body *:not(.ar-active){color:' + FG + ' !important;background:transparent !important;}'
      + 'p{margin:0 0 1em !important;line-height:1.75 !important;text-indent:0 !important;}'
      + 'div,section,article,blockquote,figure,table,ul,ol,pre{margin:0 0 1em !important;}'
      + 'h1,h2,h3,h4,h5,h6{line-height:1.3 !important;margin:1.4em 0 .55em !important;'
      + 'font-weight:700 !important;}'
      + 'li{margin:0 0 .45em !important;}'
      + 'img,svg,image{display:block !important;margin:1em auto !important;'
      + 'max-width:100% !important;height:auto !important;}'
      + 'a:not(.ar-active){color:' + LINK + ' !important;text-decoration:none !important;}'
      + '.ar-chapter{display:block !important;margin:0 0 2.5em !important;}'
      + '.ar-s{transition:background-color .12s ease;}'
      + '.ar-active{background:' + HL_BG + ' !important;color:' + HL_FG + ' !important;'
      + 'border-radius:4px;box-shadow:0 0 0 3px ' + HL_BG + ' !important;}';
    document.head.appendChild(style);

    var skipTags = {SCRIPT:1, STYLE:1, HEAD:1, NOSCRIPT:1};
    var nodes = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      var p = node.parentNode, skip = false;
      while (p) { if (skipTags[p.nodeName]) { skip = true; break; } p = p.parentNode; }
      if (!skip) nodes.push(node);
    }

    var sentences = [];
    var curIdx = 0;
    var curText = '';
    nodes.forEach(function(textNode){
      var text = textNode.nodeValue;
      var frag = document.createDocumentFragment();
      var re = /[^.!?]*[.!?]+["')\\]]*|[^.!?]+$/g;
      var pieces = text.match(re);
      if (!pieces || !pieces.length) pieces = [text];
      pieces.forEach(function(piece){
        if (!piece) return;
        var span = document.createElement('span');
        span.className = 'ar-s';
        span.setAttribute('data-s', curIdx);
        span.textContent = piece;
        frag.appendChild(span);
        curText += piece;
        // Only finish a sentence at a terminator once we have a reasonable chunk,
        // so very short fragments merge instead of producing choppy mini-utterances.
        if (/[.!?]["')\\]]*\\s*$/.test(piece) && curText.trim().length >= 40) {
          sentences[curIdx] = curText.trim();
          curIdx++; curText = '';
        }
      });
      if (textNode.parentNode) textNode.parentNode.replaceChild(frag, textNode);
    });
    if (curText.trim()) { sentences[curIdx] = curText.trim(); curIdx++; }
    for (var i = 0; i < curIdx; i++) { if (sentences[i] == null) sentences[i] = ''; }

    document.body.addEventListener('click', function(e){
      // Prevent internal chapter links from navigating away from the combined doc.
      var t = e.target;
      while (t && t !== document.body) {
        if (t.nodeName === 'A') { e.preventDefault(); }
        if (t.getAttribute && t.getAttribute('data-s') != null) {
          post({type:'tap', index: parseInt(t.getAttribute('data-s'), 10)});
          return;
        }
        t = t.parentNode;
      }
    }, true);

    // Live text-size / line-spacing control. A dedicated <style> appended after the
    // base reader stylesheet wins, so RN can rescale typography without a reload.
    window.arSetType = function(fs, ls){
      var s = document.getElementById('ar-type-style');
      if (!s) { s = document.createElement('style'); s.id = 'ar-type-style'; document.head.appendChild(s); }
      var size = (1.18 * fs).toFixed(3);
      var lh = (1.75 * ls).toFixed(3);
      s.textContent = 'body{font-size:' + size + 'rem !important;line-height:' + lh + ' !important;}'
        + 'p,li,div,section,article,blockquote{line-height:' + lh + ' !important;}';
    };

    window.arHighlight = function(i){
      var prev = document.querySelector('.ar-active');
      if (prev) { document.querySelectorAll('.ar-active').forEach(function(e){e.classList.remove('ar-active');}); }
      var els = document.querySelectorAll('[data-s="' + i + '"]');
      if (els.length) {
        els.forEach(function(e){ e.classList.add('ar-active'); });
        els[0].scrollIntoView({behavior:'smooth', block:'center'});
      }
    };

    window.__arReady = true;
    window.__arSentences = sentences;
    post({type:'sentences', list: sentences});
  } catch (err) {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({type:'error', message: String(err)}));
  }
  return true;
})();
`;

function EpubView({
  html,
  baseUrl,
  currentIndex,
  dark,
  bg,
  fontScale,
  lineSpacing,
  onSentences,
  onSelectSentence,
  onError,
}: EpubViewProps) {
  const webRef = useRef<any>(null);
  const readyRef = useRef(false);
  const injected = useMemo(() => buildInjectedScript(dark), [dark]);

  // Re-highlight whenever the active sentence changes (and the book is ready).
  useEffect(() => {
    if (!readyRef.current) return;
    webRef.current?.injectJavaScript(
      `window.arHighlight && window.arHighlight(${currentIndex}); true;`,
    );
  }, [currentIndex]);

  // Live-apply text size / line spacing changes once the book is ready.
  useEffect(() => {
    if (!readyRef.current) return;
    webRef.current?.injectJavaScript(
      `window.arSetType && window.arSetType(${fontScale}, ${lineSpacing}); true;`,
    );
  }, [fontScale, lineSpacing]);

  // Reset state when the book content changes.
  useEffect(() => {
    readyRef.current = false;
  }, [html]);

  // Allow only the initial document (its URL equals baseUrl); block every chapter
  // link / anchor navigation so tapping a link never replaces the scroll view.
  const handleShouldStart = useCallback(
    (req: {url?: string}) => {
      const url = req?.url ?? '';
      if (!url || url === 'about:blank') return true;
      return url === baseUrl || url === baseUrl.replace(/\/$/, '');
    },
    [baseUrl],
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const data = JSON.parse(event.nativeEvent.data) as {
          type: string;
          list?: string[];
          index?: number;
          message?: string;
        };
        if (data.type === 'sentences' && data.list) {
          readyRef.current = true;
          onSentences(data.list);
          // Apply current typography + highlight once content is ready.
          webRef.current?.injectJavaScript(
            `window.arSetType && window.arSetType(${fontScale}, ${lineSpacing});` +
              `window.arHighlight && window.arHighlight(${currentIndex}); true;`,
          );
        } else if (data.type === 'tap' && typeof data.index === 'number') {
          onSelectSentence(data.index);
        } else if (data.type === 'error' && onError) {
          onError(data.message ?? 'EPUB render error');
        }
      } catch {
        // Ignore malformed messages.
      }
    },
    [currentIndex, fontScale, lineSpacing, onSentences, onSelectSentence, onError],
  );

  return (
    <View style={[styles.container, {backgroundColor: bg}]}>
      <WebView
        ref={webRef}
        source={{html, baseUrl}}
        originWhitelist={['*']}
        injectedJavaScript={injected}
        onMessage={handleMessage}
        onShouldStartLoadWithRequest={handleShouldStart}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        javaScriptEnabled
        domStorageEnabled={false}
        startInLoadingState
        style={{backgroundColor: bg}}
        onError={(syntheticEvent: {nativeEvent: {description?: string}}) => {
          const {nativeEvent} = syntheticEvent;
          onError?.(`WebView error: ${nativeEvent.description ?? 'unknown'}`);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default EpubView;
