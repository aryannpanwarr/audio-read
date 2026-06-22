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
  activeWordStart: number;
  dark: boolean;
  bg: string;
  fontScale: number;
  lineSpacing: number;
  onSentences: (sentences: string[]) => void;
  onSelectWord: (paragraph: number, charOffset: number) => void;
  onError?: (message: string) => void;
};

// Injected once the book loads. It groups the whole book's text into PARAGRAPH units
// (one per block element), wraps every word in a span tagged with its paragraph index
// (data-p) and char offset within that paragraph's text (data-c), reports the paragraph
// texts to React Native (the single TTS source of truth), and exposes:
//   arHighlight(p)       -> soft block highlight over paragraph p (+ autoscroll)
//   arHighlightWord(p,c) -> stronger highlight on the word at char offset c
// Tapping a word posts {type:'tapWord', p, c} so RN can play from there.
const buildInjectedScript = (dark: boolean) => `
(function(){
  try {
    function post(obj){ window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(obj)); }
    if (window.__arReady) { post({type:'sentences', list: window.__arParas || []}); return true; }

    var vp = document.querySelector('meta[name="viewport"]');
    if (!vp) { vp = document.createElement('meta'); vp.setAttribute('name','viewport'); document.head.appendChild(vp); }
    vp.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=4');

    var FG = ${dark} ? '#f4f6f2' : '#1d2423';
    var BG = ${dark} ? '#101312' : '#f6f7f4';
    var LINK = ${dark} ? '#2dd4bf' : '#0f766e';
    var PARA_BG = 'rgba(74,144,255,0.16)';
    var WORD_BG = 'rgba(74,144,255,0.42)';
    var style = document.createElement('style');
    style.textContent = ''
      + 'html{-webkit-text-size-adjust:100%;text-size-adjust:100%;}'
      + '*{position:static !important;float:none !important;max-width:100% !important;box-sizing:border-box !important;}'
      + 'html,body{margin:0 !important;padding:0 !important;background:' + BG + ' !important;}'
      + 'body{padding:20px 22px 240px !important;font-size:1.18rem !important;line-height:1.75 !important;'
      + 'letter-spacing:0;font-family:Georgia,"Times New Roman",serif !important;color:' + FG + ' !important;}'
      + 'body *{color:' + FG + ' !important;}'
      + 'body *:not(.ar-pactive):not(.ar-wactive){background-color:transparent !important;}'
      + 'p{margin:0 0 1em !important;line-height:1.75 !important;text-indent:0 !important;}'
      + 'div,section,article,blockquote,figure,table,ul,ol,pre{margin:0 0 1em !important;}'
      + 'h1,h2,h3,h4,h5,h6{line-height:1.3 !important;margin:1.4em 0 .55em !important;font-weight:700 !important;}'
      + 'li{margin:0 0 .45em !important;}'
      + 'img,svg,image{display:block !important;margin:1em auto !important;max-width:100% !important;height:auto !important;}'
      + 'a{text-decoration:none !important;}'
      + '.ar-chapter{display:block !important;margin:0 0 2.5em !important;}'
      + '.ar-w{transition:background-color .1s ease;border-radius:3px;}'
      + '.ar-pactive{background-color:' + PARA_BG + ' !important;border-radius:6px;'
      + 'box-shadow:0 0 0 5px ' + PARA_BG + ' !important;}'
      + '.ar-wactive{background-color:' + WORD_BG + ' !important;}';
    document.head.appendChild(style);

    var BLOCK = {P:1,LI:1,H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,BLOCKQUOTE:1,DIV:1,SECTION:1,
      ARTICLE:1,TD:1,DD:1,DT:1,FIGCAPTION:1,PRE:1};
    function blockOf(n){
      var p = n.parentNode;
      while (p && p !== document.body) { if (BLOCK[p.nodeName]) return p; p = p.parentNode; }
      return document.body;
    }

    var skipTags = {SCRIPT:1, STYLE:1, HEAD:1, NOSCRIPT:1};
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node, textNodes = [];
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      var pp = node.parentNode, skip = false;
      while (pp) { if (skipTags[pp.nodeName]) { skip = true; break; } pp = pp.parentNode; }
      if (!skip) textNodes.push(node);
    }

    var paras = [], paraEls = [], curBlock = null, curIdx = -1, curText = '';
    textNodes.forEach(function(tn){
      var blk = blockOf(tn);
      if (blk !== curBlock) {
        if (curIdx >= 0) paras[curIdx] = curText.trim();
        curBlock = blk; curIdx++; curText = ''; paraEls[curIdx] = blk;
      }
      var text = tn.nodeValue, frag = document.createDocumentFragment();
      var re = /(\\s+)|(\\S+)/g, m;
      while ((m = re.exec(text))) {
        if (m[1]) {
          if (curText.length && curText.charAt(curText.length - 1) !== ' ') {
            curText += ' '; frag.appendChild(document.createTextNode(' '));
          }
        } else {
          var word = m[2];
          if (curText.length && curText.charAt(curText.length - 1) !== ' ') {
            curText += ' '; frag.appendChild(document.createTextNode(' '));
          }
          var span = document.createElement('span');
          span.className = 'ar-w';
          span.setAttribute('data-p', curIdx);
          span.setAttribute('data-c', curText.length);
          span.textContent = word;
          frag.appendChild(span);
          curText += word;
        }
      }
      if (tn.parentNode) tn.parentNode.replaceChild(frag, tn);
    });
    if (curIdx >= 0) paras[curIdx] = curText.trim();
    for (var i = 0; i < paras.length; i++) { if (paras[i] == null) paras[i] = ''; }

    document.body.addEventListener('click', function(e){
      var t = e.target;
      while (t && t !== document.body) {
        if (t.nodeName === 'A') { e.preventDefault(); }
        if (t.classList && t.classList.contains('ar-w')) {
          post({type:'tapWord', p: parseInt(t.getAttribute('data-p'), 10), c: parseInt(t.getAttribute('data-c'), 10)});
          return;
        }
        t = t.parentNode;
      }
    }, true);

    // Live text-size / line-spacing override (wins over the base reader CSS).
    window.arSetType = function(fs, ls){
      var s = document.getElementById('ar-type-style');
      if (!s) { s = document.createElement('style'); s.id = 'ar-type-style'; document.head.appendChild(s); }
      var size = (1.18 * fs).toFixed(3);
      var lh = (1.75 * ls).toFixed(3);
      s.textContent = 'body{font-size:' + size + 'rem !important;line-height:' + lh + ' !important;}'
        + 'p,li,div,section,article,blockquote{line-height:' + lh + ' !important;}';
    };

    window.__arParaEls = paraEls;
    window.arHighlight = function(p){
      var prev = document.querySelector('.ar-pactive');
      if (prev) prev.classList.remove('ar-pactive');
      document.querySelectorAll('.ar-wactive').forEach(function(e){ e.classList.remove('ar-wactive'); });
      var el = window.__arParaEls[p];
      if (el) { el.classList.add('ar-pactive'); el.scrollIntoView({behavior:'smooth', block:'center'}); }
    };
    window.arHighlightWord = function(p, c){
      document.querySelectorAll('.ar-wactive').forEach(function(e){ e.classList.remove('ar-wactive'); });
      if (c < 0) return;
      var spans = document.querySelectorAll('.ar-w[data-p="' + p + '"]');
      var target = null;
      for (var i = 0; i < spans.length; i++) {
        var sc = parseInt(spans[i].getAttribute('data-c'), 10);
        if (sc <= c) target = spans[i]; else break;
      }
      if (target) target.classList.add('ar-wactive');
    };

    window.__arReady = true;
    window.__arParas = paras;
    post({type:'sentences', list: paras});
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
  activeWordStart,
  dark,
  bg,
  fontScale,
  lineSpacing,
  onSentences,
  onSelectWord,
  onError,
}: EpubViewProps) {
  const webRef = useRef<any>(null);
  const readyRef = useRef(false);
  const injected = useMemo(() => buildInjectedScript(dark), [dark]);

  // Soft block highlight follows the active paragraph.
  useEffect(() => {
    if (!readyRef.current) return;
    webRef.current?.injectJavaScript(
      `window.arHighlight && window.arHighlight(${currentIndex}); true;`,
    );
  }, [currentIndex]);

  // Stronger word highlight follows the exact spoken word (onRangeStart offset).
  useEffect(() => {
    if (!readyRef.current) return;
    webRef.current?.injectJavaScript(
      `window.arHighlightWord && window.arHighlightWord(${currentIndex}, ${activeWordStart}); true;`,
    );
  }, [currentIndex, activeWordStart]);

  // Live-apply text size / line spacing once the book is ready.
  useEffect(() => {
    if (!readyRef.current) return;
    webRef.current?.injectJavaScript(
      `window.arSetType && window.arSetType(${fontScale}, ${lineSpacing}); true;`,
    );
  }, [fontScale, lineSpacing]);

  useEffect(() => {
    readyRef.current = false;
  }, [html]);

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
          p?: number;
          c?: number;
          message?: string;
        };
        if (data.type === 'sentences' && data.list) {
          readyRef.current = true;
          onSentences(data.list);
          webRef.current?.injectJavaScript(
            `window.arSetType && window.arSetType(${fontScale}, ${lineSpacing});` +
              `window.arHighlight && window.arHighlight(${currentIndex}); true;`,
          );
        } else if (
          data.type === 'tapWord' &&
          typeof data.p === 'number' &&
          typeof data.c === 'number'
        ) {
          onSelectWord(data.p, data.c);
        } else if (data.type === 'error' && onError) {
          onError(data.message ?? 'EPUB render error');
        }
      } catch {
        // Ignore malformed messages.
      }
    },
    [currentIndex, fontScale, lineSpacing, onSentences, onSelectWord, onError],
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
