import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {StyleSheet, View} from 'react-native';
import {WebView as RNWebView} from 'react-native-webview';

// react-native-webview's published types don't resolve cleanly against React 19's
// stricter JSX class-component typing, so we use it through a loosely typed alias.
const WebView = RNWebView as unknown as React.ComponentType<any>;

type WebViewMessageEvent = {nativeEvent: {data: string}};

type EpubViewProps = {
  chapterUri: string;
  currentIndex: number;
  dark: boolean;
  bg: string;
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

    var style = document.createElement('style');
    style.textContent = ''
      + 'html{-webkit-text-size-adjust:100%;text-size-adjust:100%;}'
      + 'html,body{margin:0 !important;padding:0 !important;}'
      + 'body{padding:18px 20px 180px !important;line-height:1.65 !important;'
      + 'font-size:1.15rem !important;max-width:100% !important;'
      + 'color:' + (${dark} ? "'#f4f6f2'" : "'#1d2423'") + ' !important;'
      + 'background:' + (${dark} ? "'#101312'" : "'#f6f7f4'") + ' !important;}'
      + 'p,div,span,li,td,h1,h2,h3,h4,h5,h6,blockquote{max-width:100% !important;}'
      + 'img,svg,image{max-width:100% !important;height:auto !important;}'
      + 'a{color:' + (${dark} ? "'#2dd4bf'" : "'#0f766e'") + ' !important;}'
      + '.ar-s{transition:background-color .12s ease;}'
      + '.ar-active{background:' + (${dark} ? "'#7a5c12'" : "'#ffe08a'") + ' !important;'
      + 'color:' + (${dark} ? "'#fff'" : "'#1d2423'") + ' !important;'
      + 'border-radius:4px;box-shadow:0 0 0 2px ' + (${dark} ? "'#7a5c12'" : "'#ffe08a'") + ';}';
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
      var t = e.target;
      while (t && t !== document.body) {
        if (t.getAttribute && t.getAttribute('data-s') != null) {
          post({type:'tap', index: parseInt(t.getAttribute('data-s'), 10)});
          return;
        }
        t = t.parentNode;
      }
    });

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
  chapterUri,
  currentIndex,
  dark,
  bg,
  onSentences,
  onSelectSentence,
  onError,
}: EpubViewProps) {
  const webRef = useRef<any>(null);
  const readyRef = useRef(false);
  const injected = useMemo(() => buildInjectedScript(dark), [dark]);

  // Re-highlight whenever the active sentence changes (and the chapter is ready).
  useEffect(() => {
    if (!readyRef.current) return;
    webRef.current?.injectJavaScript(
      `window.arHighlight && window.arHighlight(${currentIndex}); true;`,
    );
  }, [currentIndex]);

  // Reset ready state when the chapter source changes.
  useEffect(() => {
    readyRef.current = false;
  }, [chapterUri]);

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
          // Apply the current highlight once content is ready.
          webRef.current?.injectJavaScript(
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
    [currentIndex, onSentences, onSelectSentence, onError],
  );

  return (
    <View style={[styles.container, {backgroundColor: bg}]}>
      <WebView
        ref={webRef}
        source={{uri: chapterUri}}
        originWhitelist={['*']}
        injectedJavaScript={injected}
        onMessage={handleMessage}
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
