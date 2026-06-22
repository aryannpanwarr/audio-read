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
  onSelectWord: (unit: number, charOffset: number) => void;
  onError?: (message: string) => void;
};

// Injected once the book loads. It groups the whole book's text into sentence-like
// units (ending at . ! ? — minus common abbreviations — or at a block boundary),
// wraps every word in a span tagged
// with its unit index (data-p) and char offset within that unit's text (data-c),
// reports those units to React Native (the single TTS source of truth), and exposes:
//   arHighlight(p)       -> soft highlight over unit p (+ autoscroll)
//   arHighlightWord(p,c) -> stronger highlight on the word at char offset c
// Tapping a word posts {type:'tapWord', p, c} so RN can play from there.
const buildInjectedScript = (dark: boolean) => `
(function(){
  try {
    function post(obj){ window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(obj)); }
    if (window.__arReady) { post({type:'sentences', list: window.__arUnits || []}); return true; }

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
      + 'body *:not(.ar-uactive):not(.ar-wactive){background-color:transparent !important;}'
      + 'p{margin:0 0 1em !important;line-height:1.75 !important;text-indent:0 !important;}'
      + 'div,section,article,blockquote,figure,table,ul,ol,pre{margin:0 0 1em !important;}'
      + 'h1,h2,h3,h4,h5,h6{line-height:1.3 !important;margin:1.4em 0 .55em !important;font-weight:700 !important;}'
      + 'li{margin:0 0 .45em !important;}'
      + 'img,svg,image{display:block !important;margin:1em auto !important;max-width:100% !important;height:auto !important;}'
      + 'a{text-decoration:none !important;}'
      + '.ar-chapter{display:block !important;margin:0 0 2.5em !important;}'
      + '.ar-w,.ar-s{transition:background-color .1s ease;}'
      // Active unit: a single continuous band. Words + the spaces between them
      // share a flat (no radius, no shadow) background so adjacent tokens butt
      // together into one block that wraps cleanly across lines.
      + '.ar-uactive{background-color:' + PARA_BG + ' !important;border-radius:0 !important;'
      + 'box-shadow:none !important;padding:0.06em 0 !important;'
      + '-webkit-box-decoration-break:clone;box-decoration-break:clone;}'
      // Word tracker: a brighter rounded pill riding on top of the band.
      + '.ar-wactive{background-color:' + WORD_BG + ' !important;border-radius:4px !important;}';
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

    var units = [], curBlock = null, curIdx = 0, curText = '';
    function finishUnit(){
      var text = curText.trim();
      if (text) { units[curIdx] = text; curIdx++; }
      curText = '';
    }
    // The inter-word space is wrapped in its own span tagged with the unit
    // index so it can be highlighted too — that's what turns the active-unit
    // highlight into one continuous band instead of separate per-word pills.
    function appendSpace(frag){
      if (curText.length && curText.charAt(curText.length - 1) !== ' ') {
        var sp = document.createElement('span');
        sp.className = 'ar-s';
        sp.setAttribute('data-p', curIdx);
        sp.setAttribute('data-c', curText.length);
        sp.textContent = ' ';
        frag.appendChild(sp);
        curText += ' ';
      }
    }
    // Common abbreviations whose trailing '.' must NOT end a sentence unit,
    // otherwise "Mr.", "Mrs.", initials, etc. cause a jarring mid-sentence pause.
    var ABBR = {mr:1,mrs:1,ms:1,dr:1,st:1,sr:1,jr:1,prof:1,gen:1,col:1,sgt:1,
      capt:1,lt:1,cpl:1,maj:1,rev:1,hon:1,pres:1,messrs:1,mt:1,ft:1,etc:1,vs:1,
      no:1,al:1,fig:1,vol:1,ch:1,pp:1,inc:1,ltd:1,co:1,corp:1,dept:1,est:1,
      approx:1,'e.g':1,'i.e':1,'a.m':1,'p.m':1};
    function endsSentence(word){
      if (/[!?]["')\\]]*$/.test(word)) return true;     // ! or ? always end a unit
      if (!/\\.["')\\]]*$/.test(word)) return false;     // no terminal '.' -> not an end
      var core = word.replace(/["')\\]]+$/, '').slice(0, -1); // strip closers + the '.'
      if (/^[A-Za-z]$/.test(core)) return false;         // single initial e.g. "J."
      if (/^([A-Za-z]\\.)+[A-Za-z]$/.test(core)) return false; // dotted form e.g. "U.S."
      if (ABBR[core.toLowerCase()]) return false;        // known abbreviation
      return true;
    }
    textNodes.forEach(function(tn){
      var blk = blockOf(tn);
      if (blk !== curBlock) {
        if (curBlock !== null) finishUnit();
        curBlock = blk;
      }
      var text = tn.nodeValue, frag = document.createDocumentFragment();
      var re = /(\\s+)|(\\S+)/g, m;
      while ((m = re.exec(text))) {
        if (m[1]) {
          if (curText.length) appendSpace(frag);
          else frag.appendChild(document.createTextNode(' '));
        } else {
          var word = m[2];
          appendSpace(frag);
          var span = document.createElement('span');
          span.className = 'ar-w';
          span.setAttribute('data-p', curIdx);
          span.setAttribute('data-c', curText.length);
          span.textContent = word;
          frag.appendChild(span);
          curText += word;
          if (endsSentence(word)) finishUnit();
        }
      }
      if (tn.parentNode) tn.parentNode.replaceChild(frag, tn);
    });
    finishUnit();
    for (var i = 0; i < units.length; i++) { if (units[i] == null) units[i] = ''; }

    document.body.addEventListener('click', function(e){
      var t = e.target;
      while (t && t !== document.body) {
        if (t.nodeName === 'A') { e.preventDefault(); }
        if (t.classList && (t.classList.contains('ar-w') || t.classList.contains('ar-s'))) {
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

    window.arHighlight = function(p){
      document.querySelectorAll('.ar-uactive').forEach(function(e){ e.classList.remove('ar-uactive'); });
      document.querySelectorAll('.ar-wactive').forEach(function(e){ e.classList.remove('ar-wactive'); });
      // Words AND the spaces between them, so the band is continuous.
      var spans = document.querySelectorAll('.ar-w[data-p="' + p + '"],.ar-s[data-p="' + p + '"]');
      spans.forEach(function(e){ e.classList.add('ar-uactive'); });
      if (spans.length) spans[0].scrollIntoView({behavior:'smooth', block:'center'});
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
    window.__arUnits = units;
    post({type:'sentences', list: units});
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

  // Soft highlight follows the active sentence-like unit.
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
