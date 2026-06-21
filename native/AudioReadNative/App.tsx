import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  FlatList,
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import EpubView from './src/EpubView';
import PdfView from './src/PdfView';
import VoicePicker, {TtsVoice} from './src/VoicePicker';

type EpubChapter = {
  uri: string;
  path: string;
};

type BookManifest = {
  id: string;
  kind: 'pdf' | 'epub' | 'text';
  chapters?: EpubChapter[];
  baseDir?: string;
  pageCount?: number;
  sourcePath?: string;
};

type InitResult = {
  sampleRate: number;
  speakers: number;
  model: string;
  engine?: string;
  voices?: TtsVoice[];
};

type SpeakResult = {
  elapsedSeconds: number;
  audioDurationSeconds: number;
  rtf: number;
  sampleRate: number;
  samples: number;
  source?: string;
  wordCount?: number;
};

type PickedDocument = {
  title: string;
  text: string;
  uri: string;
  kind: 'pdf' | 'epub' | 'text';
};

type LibraryBook = {
  id: string;
  title: string;
  kind: 'pdf' | 'epub' | 'text';
  uri: string;
  sentenceCount: number;
  charCount: number;
  createdAt: number;
  updatedAt: number;
  lastPosition: number;
  lastChapter?: number;
};

type LoadedLibraryBook = LibraryBook & {
  text: string;
};

type SpeechTiming = {
  audioDurationSeconds: number;
  wordCount: number;
};

type SystemTtsModule = {
  initialize(): Promise<InitResult>;
  speak(text: string, voiceName: string | null, speed: number): Promise<SpeakResult>;
  stop(): Promise<void>;
  startPlaybackSession(): Promise<void>;
  stopPlaybackSession(): Promise<void>;
  requestBackgroundPlaybackPermission(): Promise<boolean>;
  record(message: string): Promise<void>;
  exportLogs(): Promise<string>;
};

type DocumentReaderModule = {
  pickDocument(): Promise<PickedDocument>;
  listLibrary(): Promise<LibraryBook[]>;
  saveLibraryDocument(
    title: string,
    kind: string,
    uri: string,
    text: string,
    sentenceCount: number,
  ): Promise<LibraryBook>;
  loadLibraryDocument(id: string): Promise<LoadedLibraryBook>;
  updateLibraryDocument(id: string, patch: Partial<LibraryBook>): Promise<LibraryBook>;
  deleteLibraryDocument(id: string): Promise<void>;
  getBookManifest(id: string): Promise<BookManifest>;
};

const SystemTts = NativeModules.SystemTts as SystemTtsModule;
const DocumentReader = NativeModules.DocumentReader as DocumentReaderModule;

declare const global: {
  ErrorUtils?: {
    getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
    setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
  };
};

type Sentence = {
  id: number;
  text: string;
};

const describeError = (error: unknown) => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`;
  }
  return String(error);
};

const recordLog = (message: string) => {
  void SystemTts.record(message).catch(() => {});
};

// Module-level so it is shared across every render/closure (and any re-mounted App
// instance). Any action that should stop playback bumps this; each speak loop captures
// its value and exits the moment it no longer matches, guaranteeing a single live loop.
let playGeneration = 0;

const previousErrorHandler = global.ErrorUtils?.getGlobalHandler?.();
global.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
  recordLog(`global-js-error fatal=${Boolean(isFatal)} ${describeError(error)}`);
  previousErrorHandler?.(error, isFatal);
});

function splitSentences(text: string): Sentence[] {
  const paragraphs = text
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .split(/\n{2,}/)
    .map(part => part.replace(/\s{2,}/g, ' ').trim())
    .filter(isReadableParagraph);
  const rawParts = paragraphs.flatMap(paragraph => {
    if (isHeading(paragraph)) return [paragraph];
    return paragraph.match(/[^.!?]+(?:[.!?]+["')\]]+|[.!?]+)?|[^.!?]+$/g) ?? [paragraph];
  });
  return mergeSpeechParts(rawParts.map(part => part.trim()).filter(isReadableParagraph))
    .slice(0, 8000)
    .map((part, index) => ({id: index, text: part}));
}

function isReadableParagraph(text: string) {
  if (text.length < 2) return false;
  if (/^(?:page\s*)?\d{1,4}$/i.test(text)) return false;
  if (/^\[?(?:pg|page)\s*\d{1,4}\]?$/i.test(text)) return false;
  return /[A-Za-z0-9]/.test(text);
}

function isHeading(text: string) {
  if (text.length > 120) return false;
  return /^(chapter|part|book|volume)\b/i.test(text) || /^[A-Z0-9 ,.'"-]{8,}$/.test(text);
}

function mergeSpeechParts(parts: string[]) {
  const merged: string[] = [];
  let carry = '';
  parts.forEach(part => {
    const current = carry ? `${carry} ${part}`.trim() : part;
    if (isHeading(current)) {
      if (carry && carry !== current) merged.push(carry);
      merged.push(part);
      carry = '';
      return;
    }
    if (current.length < 45) {
      carry = current;
      return;
    }
    merged.push(current);
    carry = '';
  });
  if (carry) {
    if (merged.length && carry.length < 45) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${carry}`.trim();
    } else {
      merged.push(carry);
    }
  }
  return merged.filter(Boolean);
}

function splitWords(text: string) {
  return text.split(/(\s+)/).filter(part => part.length > 0);
}

function isWord(part: string) {
  return /\S/.test(part);
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function App() {
  const dark = useColorScheme() === 'dark';
  const colors = dark ? darkColors : lightColors;
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [library, setLibrary] = useState<LibraryBook[]>([]);
  const [view, setView] = useState<'library' | 'reader'>('library');
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [documentTitle, setDocumentTitle] = useState('');
  const [documentKind, setDocumentKind] = useState<'pdf' | 'epub' | 'text'>('text');
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [current, setCurrent] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [ready, setReady] = useState<InitResult | null>(null);
  const [voiceIndex, setVoiceIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Library ready');
  const [lastResult, setLastResult] = useState<SpeakResult | null>(null);
  const [activeWordCount, setActiveWordCount] = useState(0);
  const [showVoices, setShowVoices] = useState(false);
  const [chapters, setChapters] = useState<EpubChapter[]>([]);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const listRef = useRef<FlatList<Sentence>>(null);
  const commandHandlerRef = useRef<(command: string) => void>(() => {});
  const timingHandlerRef = useRef<(timing: SpeechTiming) => void>(() => {});
  const wordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sentencesRef = useRef(sentences);
  const currentRef = useRef(current);
  const backgroundPermissionPromptedRef = useRef(false);
  const chaptersRef = useRef(chapters);
  const chapterIndexRef = useRef(chapterIndex);
  const sentencesResolveRef = useRef<((value: Sentence[]) => void) | null>(null);

  const voices = ready?.voices ?? [];
  const selectedVoice = voices[voiceIndex]?.name ?? null;

  function updateBookInState(book: LibraryBook) {
    setLibrary(items => [book, ...items.filter(item => item.id !== book.id)]);
  }

  function clearWordProgress() {
    if (wordTimerRef.current) {
      clearInterval(wordTimerRef.current);
      wordTimerRef.current = null;
    }
    setActiveWordCount(0);
  }

  function startWordProgress(timing: SpeechTiming) {
    clearWordProgress();
    const sentence = sentencesRef.current[currentRef.current];
    if (!sentence || timing.audioDurationSeconds <= 0) return;
    const wordCount = Math.max(
      1,
      splitWords(sentence.text).filter(isWord).length || timing.wordCount,
    );
    const durationMs = Math.max(300, timing.audioDurationSeconds * 1000);
    const startedAt = Date.now();
    setActiveWordCount(1);
    wordTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const nextCount = Math.min(wordCount, Math.max(1, Math.ceil((elapsed / durationMs) * wordCount)));
      setActiveWordCount(nextCount);
      if (nextCount >= wordCount && wordTimerRef.current) {
        clearInterval(wordTimerRef.current);
        wordTimerRef.current = null;
      }
    }, 90);
  }

  const refreshLibrary = async () => {
    try {
      const items = await DocumentReader.listLibrary();
      setLibrary(items);
      recordLog(`ui library loaded count=${items.length}`);
    } catch (error) {
      recordLog(`ui library load failed ${describeError(error)}`);
    }
  };

  const requestBackgroundPermission = async () => {
    if (backgroundPermissionPromptedRef.current || Platform.OS !== 'android') return;
    backgroundPermissionPromptedRef.current = true;
    try {
      const opened = await SystemTts.requestBackgroundPlaybackPermission();
      recordLog(`ui background permission prompt opened=${opened}`);
    } catch (error) {
      recordLog(`ui background permission prompt failed ${describeError(error)}`);
    }
  };

  // Kept identity-stable (empty deps) via a ref so the mount effect below runs exactly
  // once. When it depended on `ready`, flipping ready re-ran init/library side effects.
  const readyDataRef = useRef<InitResult | null>(null);
  const ensureReady = useCallback(async () => {
    if (readyDataRef.current) return readyDataRef.current;
    setStatus('Loading Android voice...');
    const info = await SystemTts.initialize();
    readyDataRef.current = info;
    setReady(info);
    setVoiceIndex(Math.max(0, info.voices?.findIndex(voice => voice.locale.toLowerCase().startsWith('en')) ?? 0));
    setStatus(`System TTS ready${info.engine ? ` · ${info.engine}` : ''}`);
    return info;
  }, []);

  useEffect(() => {
    recordLog('reader app mounted');
    void Promise.resolve().then(refreshLibrary);
    void Promise.resolve().then(ensureReady).catch(error => recordLog(`tts init failed ${describeError(error)}`));
    void Promise.resolve().then(requestBackgroundPermission);
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      void PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(error => {
        recordLog(`notification permission request failed ${describeError(error)}`);
      });
    }
  }, [ensureReady]);

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.SystemTts);
    const commandSubscription = emitter.addListener('AudioReadPlaybackCommand', command => {
      recordLog(`ui playback command ${String(command)}`);
      commandHandlerRef.current(String(command));
    });
    const timingSubscription = emitter.addListener('AudioReadSpeechTiming', timing => {
      timingHandlerRef.current(timing as SpeechTiming);
    });
    return () => {
      commandSubscription.remove();
      timingSubscription.remove();
      clearWordProgress();
    };
  }, []);

  useEffect(() => {
    sentencesRef.current = sentences;
    currentRef.current = current;
    chaptersRef.current = chapters;
    chapterIndexRef.current = chapterIndex;
  }, [sentences, current, chapters, chapterIndex]);

  useEffect(() => {
    if (sentences.length) {
      listRef.current?.scrollToIndex({
        index: current,
        animated: true,
        viewPosition: 0.22,
      });
    }
  }, [current, sentences.length]);

  const withinChapter = sentences.length ? (current + 1) / sentences.length : 0;
  const progress =
    documentKind === 'epub' && chapters.length
      ? Math.round(((chapterIndex + withinChapter) / chapters.length) * 100)
      : sentences.length
        ? Math.round(withinChapter * 100)
        : 0;
  const pdfCurrentPage =
    pageCount > 0 && sentences.length > 0
      ? Math.min(pageCount - 1, Math.floor((current / sentences.length) * pageCount))
      : 0;

  // Called by the EPUB WebView once it has wrapped a chapter's text into sentence
  // spans. This becomes the source of truth for TTS + highlighting in that chapter.
  const handleEpubSentences = (list: string[]) => {
    const parsed = list.map((text, id) => ({id, text}));
    setSentences(parsed);
    sentencesRef.current = parsed;
    const resolve = sentencesResolveRef.current;
    if (resolve) {
      sentencesResolveRef.current = null;
      resolve(parsed);
    }
  };

  const loadChapterAndWait = (index: number): Promise<Sentence[]> =>
    new Promise(resolve => {
      let settled = false;
      const finish = (value: Sentence[]) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      sentencesResolveRef.current = finish;
      setChapterIndex(index);
      chapterIndexRef.current = index;
      // Safety net in case the chapter has no readable text / fails to report.
      setTimeout(() => finish(sentencesRef.current), 8000);
    });

  const loadManifest = async (book: LibraryBook) => {
    setChapters([]);
    setChapterIndex(0);
    setPageCount(0);
    chaptersRef.current = [];
    chapterIndexRef.current = 0;
    if (book.kind !== 'epub' && book.kind !== 'pdf') return;
    try {
      const manifest = await DocumentReader.getBookManifest(book.id);
      if (manifest.kind === 'epub' && manifest.chapters?.length) {
        const startChapter = Math.max(0, Math.min(manifest.chapters.length - 1, book.lastChapter ?? 0));
        setChapters(manifest.chapters);
        chaptersRef.current = manifest.chapters;
        setChapterIndex(startChapter);
        chapterIndexRef.current = startChapter;
        recordLog(`ui epub manifest chapters=${manifest.chapters.length} start=${startChapter}`);
      } else if (manifest.kind === 'pdf' && manifest.pageCount) {
        setPageCount(manifest.pageCount);
        recordLog(`ui pdf manifest pages=${manifest.pageCount}`);
      }
    } catch (error) {
      recordLog(`ui manifest load failed ${describeError(error)}`);
    }
  };

  const enterReader = async (book: LibraryBook, text: string) => {
    playGeneration++;
    await SystemTts.stop();
    await SystemTts.stopPlaybackSession();
    clearWordProgress();
    setPlaying(false);
    setActiveBookId(book.id);
    setDocumentTitle(book.title);
    setDocumentKind(book.kind);
    setLastResult(null);
    setView('reader');
    if (book.kind === 'epub') {
      setSentences([]);
      sentencesRef.current = [];
      setCurrent(Math.max(0, book.lastPosition || 0));
      setStatus('Loading book layout...');
      await loadManifest(book);
      // Older books (saved before original-layout rendering) have no extracted
      // chapter assets; fall back to the plain-text reader so they still work.
      if (!chaptersRef.current.length) {
        const parsed = splitSentences(text);
        setSentences(parsed);
        sentencesRef.current = parsed;
        setCurrent(Math.max(0, Math.min(parsed.length - 1, book.lastPosition || 0)));
        setStatus('Ready to read');
        recordLog('ui epub fallback to text reader (no render assets)');
      }
    } else {
      const parsed = splitSentences(text);
      setSentences(parsed);
      sentencesRef.current = parsed;
      setCurrent(Math.max(0, Math.min(parsed.length - 1, book.lastPosition || 0)));
      setStatus('Ready to read');
      if (book.kind === 'pdf') await loadManifest(book);
    }
  };

  const openDocument = async () => {
    try {
      recordLog('ui open document pressed');
      setBusy(true);
      setStatus('Opening document...');
      const doc = await DocumentReader.pickDocument();
      const parsed = splitSentences(doc.text);
      if (!parsed.length) throw new Error('No readable sentences found in this document');
      const book = await DocumentReader.saveLibraryDocument(
        doc.title,
        doc.kind,
        doc.uri,
        doc.text,
        parsed.length,
      );
      updateBookInState(book);
      await enterReader(book, doc.text);
      setStatus(`${doc.kind.toUpperCase()} added · ready to read`);
      recordLog(`ui document loaded title=${doc.title} kind=${doc.kind} sentences=${parsed.length}`);
    } catch (error) {
      const message = describeError(error);
      if (message.includes('DOCUMENT_PICK_CANCELLED')) {
        setStatus('Ready');
      } else {
        Alert.alert('Could not open document', message);
        setStatus('Document open failed');
      }
      recordLog(`ui open document failed ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const openLibraryBook = async (book: LibraryBook) => {
    try {
      recordLog(`ui library book pressed id=${book.id}`);
      setBusy(true);
      setStatus('Opening book...');
      const loaded = await DocumentReader.loadLibraryDocument(book.id);
      await enterReader(loaded, loaded.text);
    } catch (error) {
      Alert.alert('Could not open book', describeError(error));
      setStatus('Book open failed');
      recordLog(`ui open library book failed ${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteBook = async (book: LibraryBook) => {
    try {
      await DocumentReader.deleteLibraryDocument(book.id);
      setLibrary(items => items.filter(item => item.id !== book.id));
      if (activeBookId === book.id) {
        playGeneration++;
        await SystemTts.stop();
        await SystemTts.stopPlaybackSession();
        clearWordProgress();
        setActiveBookId(null);
        setSentences([]);
        setChapters([]);
        setPageCount(0);
        setCurrent(0);
        setPlaying(false);
        setView('library');
      }
      setStatus('Book removed');
    } catch (error) {
      Alert.alert('Could not remove book', describeError(error));
    }
  };

  const persistProgress = (index: number) => {
    if (!activeBookId) return;
    const patch: Partial<LibraryBook> = {lastPosition: index};
    if (documentKind === 'epub') patch.lastChapter = chapterIndexRef.current;
    void DocumentReader.updateLibraryDocument(activeBookId, patch)
      .then(updateBookInState)
      .catch(error => recordLog(`ui progress update failed ${describeError(error)}`));
  };

  const speakAt = async (startIndex: number) => {
    if (!sentencesRef.current.length && documentKind !== 'epub') return;
    const token = ++playGeneration;
    setPlaying(true);
    setBusy(true);
    try {
      void requestBackgroundPermission();
      await ensureReady();
      await SystemTts.startPlaybackSession();
      // EPUB chapters report their sentences asynchronously from the WebView; wait for
      // the current chapter before reading so we don't skip it.
      if (documentKind === 'epub' && !sentencesRef.current.length) {
        setStatus('Preparing chapter...');
        await new Promise<Sentence[]>(resolve => {
          let settled = false;
          const finish = (value: Sentence[]) => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          sentencesResolveRef.current = finish;
          setTimeout(() => finish(sentencesRef.current), 8000);
        });
        if (token !== playGeneration) return;
      }
      let index = startIndex;
      while (true) {
        if (token !== playGeneration) return;
        const segment = sentencesRef.current;
        if (index >= segment.length) {
          // EPUB: advance to the next chapter and keep reading.
          if (documentKind === 'epub' && chapterIndexRef.current < chaptersRef.current.length - 1) {
            setStatus('Loading next chapter...');
            await loadChapterAndWait(chapterIndexRef.current + 1);
            if (token !== playGeneration) return;
            index = 0;
            setCurrent(0);
            continue;
          }
          break;
        }
        const sentence = segment[index];
        setCurrent(index);
        persistProgress(index);
        setActiveWordCount(0);
        const speakText = sentence.text.trim();
        if (speakText.length < 2) {
          index += 1;
          continue;
        }
        setStatus(`Reading ${index + 1} of ${segment.length}`);
        recordLog(`ui reading sentence=${index} chars=${speakText.length}`);
        const result = await SystemTts.speak(speakText, selectedVoice, speed);
        if (token !== playGeneration) return;
        setLastResult(result);
        index += 1;
      }
      setStatus('Finished');
      setPlaying(false);
      clearWordProgress();
      await SystemTts.stopPlaybackSession();
    } catch (error) {
      const message = describeError(error);
      setStatus('Playback failed');
      setPlaying(false);
      clearWordProgress();
      await SystemTts.stopPlaybackSession().catch(() => {});
      Alert.alert('Playback failed', message);
      recordLog(`ui playback failed ${message}`);
    } finally {
      if (token === playGeneration) {
        setBusy(false);
      }
    }
  };

  const playPause = async () => {
    if (busy && !playing) return;
    if (playing) {
      recordLog('ui pause pressed');
      playGeneration++;
      setPlaying(false);
      setBusy(false);
      await SystemTts.stop();
      await SystemTts.stopPlaybackSession();
      clearWordProgress();
      setStatus('Paused');
      return;
    }
    recordLog(`ui play pressed current=${current}`);
    void speakAt(current);
  };

  const skipTo = async (next: number) => {
    const bounded = Math.max(0, Math.min(sentences.length - 1, next));
    const shouldResume = playing;
    recordLog(`ui skip ${current}->${bounded} resume=${shouldResume}`);
    playGeneration++;
    await SystemTts.stop();
    clearWordProgress();
    setCurrent(bounded);
    persistProgress(bounded);
    setPlaying(false);
    setBusy(false);
    if (shouldResume) {
      void speakAt(bounded);
    } else {
      await SystemTts.stopPlaybackSession();
      setStatus(`Ready at ${bounded + 1} of ${sentences.length}`);
    }
  };

  useEffect(() => {
    commandHandlerRef.current = command => {
      if (command === 'pause') {
        void playPause();
      } else if (command === 'previous') {
        void skipTo(current - 1);
      } else if (command === 'next') {
        void skipTo(current + 1);
      }
    };
    timingHandlerRef.current = startWordProgress;
  });

  const previewVoice = useCallback(async (voice: TtsVoice) => {
    try {
      await ensureReady();
      await SystemTts.stop();
      recordLog(`ui voice preview ${voice.name}`);
      void SystemTts.speak(
        'This is a preview of the selected reading voice.',
        voice.name,
        1,
      ).catch(error => recordLog(`ui voice preview failed ${describeError(error)}`));
    } catch (error) {
      recordLog(`ui voice preview failed ${describeError(error)}`);
    }
  }, [ensureReady]);

  const handlePdfError = useCallback((message: string) => recordLog(`pdf view ${message}`), []);
  const handleEpubError = useCallback((message: string) => recordLog(`epub view ${message}`), []);

  const exportLogs = async () => {
    try {
      recordLog('ui export logs pressed');
      await SystemTts.exportLogs();
    } catch (error) {
      Alert.alert('Could not export logs', describeError(error));
    }
  };

  const renderSentence = (sentence: Sentence) => {
    if (sentence.id !== current) return sentence.text;
    let spokenWords = 0;
    return splitWords(sentence.text).map((part, index) => {
      if (!isWord(part)) return part;
      spokenWords += 1;
      return (
        <Text key={`${sentence.id}-${index}`} style={spokenWords <= activeWordCount && styles.spokenWord}>
          {part}
        </Text>
      );
    });
  };

  const renderSentenceItem = ({item}: {item: Sentence}) => (
    <Pressable onPress={() => skipTo(item.id)}>
      <Text style={[styles.sentence, item.id === current && styles.currentSentence]}>{renderSentence(item)}</Text>
    </Pressable>
  );

  const bookProgress = (book: LibraryBook) =>
    book.sentenceCount > 0
      ? Math.max(0, Math.min(100, Math.round(((book.lastPosition + 1) / book.sentenceCount) * 100)))
      : 0;

  const renderBookItem = ({item}: {item: LibraryBook}) => (
    <Pressable style={styles.bookRow} onPress={() => openLibraryBook(item)}>
      <View style={styles.bookCover}>
        <Text style={styles.bookCoverText}>{item.kind.toUpperCase()}</Text>
      </View>
      <View style={styles.bookInfo}>
        <Text style={styles.bookTitle} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={styles.bookMeta} numberOfLines={1}>
          {item.sentenceCount} sections · {bookProgress(item)}% read
        </Text>
        <View style={styles.bookProgressTrack}>
          <View style={[styles.bookProgressFill, {width: `${bookProgress(item)}%`}]} />
        </View>
        <Text style={styles.localPill} numberOfLines={1}>
          Local system voice
        </Text>
      </View>
      <Pressable
        style={styles.deleteButton}
        onPress={event => {
          event.stopPropagation();
          void deleteBook(item);
        }}
        disabled={busy || playing}
        hitSlop={10}>
        <Text style={styles.deleteButtonText}>x</Text>
      </Pressable>
    </Pressable>
  );

  const handleScrollToIndexFailed = (info: {
    index: number;
    highestMeasuredFrameIndex: number;
    averageItemLength: number;
  }) => {
    listRef.current?.scrollToOffset({
      offset: Math.max(0, info.averageItemLength * info.index),
      animated: false,
    });
    setTimeout(() => {
      listRef.current?.scrollToIndex({
        index: info.index,
        animated: true,
        viewPosition: 0.2,
      });
    }, 100);
  };

  if (view === 'library') {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />
        <View style={styles.libraryHeader}>
          <View>
            <Text style={styles.title}>Audio Read</Text>
            <Text style={styles.subtitle}>Library</Text>
          </View>
          <Pressable style={[styles.openButton, busy && styles.disabled]} onPress={openDocument} disabled={busy}>
            <Text style={styles.openButtonText}>Import</Text>
          </Pressable>
        </View>

        <FlatList
          data={library}
          keyExtractor={item => item.id}
          renderItem={renderBookItem}
          contentContainerStyle={styles.libraryContent}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>No books yet</Text>
              <Text style={styles.emptyText}>Import a PDF, EPUB, or TXT file to add it to your library.</Text>
              <Pressable style={styles.emptyButton} onPress={openDocument} disabled={busy}>
                <Text style={styles.openButtonText}>Import document</Text>
              </Pressable>
            </View>
          }
        />

        <View style={styles.libraryFooter}>
          <Text style={styles.status} numberOfLines={2}>
            {status}
          </Text>
          <Pressable style={styles.logButtonWide} onPress={exportLogs}>
            <Text style={styles.logButtonText}>Export Logs</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => setView('library')} disabled={busy && !playing}>
          <Text style={styles.backButtonText}>‹</Text>
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.readerTitle} numberOfLines={1}>
            {documentTitle || 'Reader'}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {documentKind.toUpperCase()} · {sentences.length} sections
          </Text>
        </View>
        <Pressable style={[styles.openButton, busy && styles.disabled]} onPress={openDocument} disabled={busy}>
          <Text style={styles.openButtonText}>Import</Text>
        </Pressable>
      </View>

      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, {width: `${progress}%`}]} />
      </View>

      <View style={styles.readerBody}>
        {documentKind === 'epub' && chapters.length ? (
          <EpubView
            chapterUri={chapters[chapterIndex].uri}
            currentIndex={current}
            dark={dark}
            bg={colors.bg}
            onSentences={handleEpubSentences}
            onSelectSentence={skipTo}
            onError={handleEpubError}
          />
        ) : documentKind === 'pdf' && pageCount > 0 && activeBookId ? (
          <PdfView
            bookId={activeBookId}
            pageCount={pageCount}
            currentPage={pdfCurrentPage}
            colors={colors}
            onSelectPage={page =>
              skipTo(Math.floor((page / Math.max(1, pageCount)) * sentences.length))
            }
            onError={handlePdfError}
          />
        ) : (
          <FlatList
            ref={listRef}
            data={sentences}
            keyExtractor={item => String(item.id)}
            renderItem={renderSentenceItem}
            contentContainerStyle={styles.readerContent}
            initialNumToRender={20}
            maxToRenderPerBatch={14}
            windowSize={9}
            removeClippedSubviews
            onScrollToIndexFailed={handleScrollToIndexFailed}
          />
        )}
      </View>

      <View style={styles.bottomBar}>
        <Text style={styles.status} numberOfLines={2}>
          {status}
        </Text>

        <View style={styles.controls}>
          <Pressable
            style={styles.iconButton}
            onPress={() => skipTo(current - 1)}
            disabled={(busy && !playing) || current === 0}>
            <Text style={styles.iconButtonText}>‹</Text>
          </Pressable>
          <Pressable
            style={[styles.playButton, busy && !playing && styles.disabled]}
            onPress={playPause}
            disabled={busy && !playing}>
            <Text style={styles.playButtonText}>{playing ? 'Pause' : 'Play'}</Text>
          </Pressable>
          <Pressable
            style={styles.iconButton}
            onPress={() => skipTo(current + 1)}
            disabled={(busy && !playing) || current >= sentences.length - 1}>
            <Text style={styles.iconButtonText}>›</Text>
          </Pressable>
        </View>

        <View style={styles.optionsRow}>
          <Pressable
            style={styles.optionBox}
            onPress={() => setShowVoices(true)}
            disabled={playing || voices.length === 0}>
            <Text style={styles.optionLabel}>Voice</Text>
            <View style={styles.stepperRow}>
              <Text style={styles.optionValue} numberOfLines={1}>
                {voices[voiceIndex]?.label ?? voices[voiceIndex]?.locale ?? 'System'}
              </Text>
            </View>
          </Pressable>
          <View style={styles.optionBox}>
            <Text style={styles.optionLabel}>Speed</Text>
            <View style={styles.stepperRow}>
              <Pressable
                onPress={() => setSpeed(Math.max(0.7, Number((speed - 0.1).toFixed(1))))}
                disabled={playing}>
                <Text style={styles.stepperText}>-</Text>
              </Pressable>
              <Text style={styles.optionValue}>{speed.toFixed(1)}x</Text>
              <Pressable
                onPress={() => setSpeed(Math.min(1.8, Number((speed + 0.1).toFixed(1))))}
                disabled={playing}>
                <Text style={styles.stepperText}>+</Text>
              </Pressable>
            </View>
          </View>
          <Pressable style={styles.logButton} onPress={exportLogs}>
            <Text style={styles.logButtonText}>Logs</Text>
          </Pressable>
        </View>

        <Text style={styles.meta}>
          {documentKind === 'epub' && chapters.length ? `Ch ${chapterIndex + 1}/${chapters.length} · ` : ''}
          {sentences.length ? `${current + 1}/${sentences.length}` : '0/0'}
          {lastResult ? ` · ${formatDuration(lastResult.audioDurationSeconds)}` : ''}
        </Text>
      </View>

      <VoicePicker
        visible={showVoices}
        voices={voices}
        selectedIndex={voiceIndex}
        colors={colors}
        onSelect={setVoiceIndex}
        onPreview={previewVoice}
        onClose={() => {
          void SystemTts.stop();
          setShowVoices(false);
        }}
      />
    </SafeAreaView>
  );
}

const lightColors = {
  bg: '#f6f7f4',
  surface: '#ffffff',
  surface2: '#e8ece7',
  text: '#1d2423',
  muted: '#69726f',
  border: '#d8ded8',
  accent: '#0f766e',
  accent2: '#b45309',
  accentText: '#ffffff',
  highlight: '#fef3c7',
};

const darkColors = {
  bg: '#101312',
  surface: '#181d1b',
  surface2: '#27302d',
  text: '#f4f6f2',
  muted: '#a7b0ac',
  border: '#303936',
  accent: '#2dd4bf',
  accent2: '#f59e0b',
  accentText: '#06211e',
  highlight: '#4a3d18',
};

function makeStyles(colors: typeof lightColors) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 18,
      paddingTop: 12,
      paddingBottom: 12,
      backgroundColor: colors.surface,
      borderBottomColor: colors.border,
      borderBottomWidth: 1,
    },
    libraryHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 18,
      paddingTop: 16,
      paddingBottom: 14,
      backgroundColor: colors.surface,
      borderBottomColor: colors.border,
      borderBottomWidth: 1,
    },
    headerText: {
      flex: 1,
    },
    title: {
      color: colors.text,
      fontSize: 22,
      fontWeight: '800',
    },
    readerTitle: {
      color: colors.text,
      fontSize: 18,
      fontWeight: '800',
    },
    subtitle: {
      color: colors.muted,
      fontSize: 13,
      marginTop: 2,
    },
    openButton: {
      backgroundColor: colors.accent,
      paddingHorizontal: 16,
      minHeight: 40,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    openButtonText: {
      color: colors.accentText,
      fontSize: 15,
      fontWeight: '800',
    },
    progressTrack: {
      height: 4,
      backgroundColor: colors.surface2,
    },
    progressFill: {
      height: 4,
      backgroundColor: colors.accent2,
    },
    libraryContent: {
      padding: 14,
      paddingBottom: 110,
      gap: 10,
    },
    bookRow: {
      flexDirection: 'row',
      gap: 12,
      minHeight: 116,
      borderRadius: 8,
      borderColor: colors.border,
      borderWidth: 1,
      backgroundColor: colors.surface,
      padding: 12,
    },
    bookCover: {
      width: 72,
      borderRadius: 6,
      backgroundColor: colors.surface2,
      borderColor: colors.border,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bookCoverText: {
      color: colors.accent,
      fontSize: 12,
      fontWeight: '900',
    },
    bookInfo: {
      flex: 1,
      minWidth: 0,
      justifyContent: 'center',
      gap: 6,
    },
    bookTitle: {
      color: colors.text,
      fontSize: 17,
      lineHeight: 22,
      fontWeight: '800',
    },
    bookMeta: {
      color: colors.muted,
      fontSize: 12,
      fontVariant: ['tabular-nums'],
    },
    bookProgressTrack: {
      height: 5,
      borderRadius: 3,
      overflow: 'hidden',
      backgroundColor: colors.surface2,
    },
    bookProgressFill: {
      height: 5,
      backgroundColor: colors.accent2,
    },
    localPill: {
      alignSelf: 'flex-start',
      maxWidth: '100%',
      color: colors.accent,
      borderColor: colors.accent,
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
      fontSize: 11,
      fontWeight: '800',
    },
    deleteButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface2,
    },
    deleteButtonText: {
      color: colors.muted,
      fontSize: 22,
      lineHeight: 24,
      fontWeight: '700',
    },
    emptyState: {
      minHeight: 420,
      justifyContent: 'center',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 22,
    },
    emptyTitle: {
      color: colors.text,
      fontSize: 24,
      fontWeight: '900',
      textAlign: 'center',
    },
    emptyText: {
      color: colors.muted,
      fontSize: 15,
      lineHeight: 22,
      textAlign: 'center',
    },
    emptyButton: {
      marginTop: 6,
      minHeight: 46,
      borderRadius: 8,
      paddingHorizontal: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
    },
    libraryFooter: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      padding: 14,
      paddingBottom: 18,
      backgroundColor: colors.surface,
      borderTopColor: colors.border,
      borderTopWidth: 1,
      gap: 10,
    },
    readerBody: {
      flex: 1,
    },
    readerContent: {
      padding: 22,
      paddingBottom: 230,
      gap: 10,
    },
    sentence: {
      color: colors.text,
      fontSize: 19,
      lineHeight: 32,
      borderRadius: 6,
      paddingHorizontal: 4,
      paddingVertical: 2,
    },
    currentSentence: {
      backgroundColor: colors.highlight,
      color: colors.text,
      fontWeight: '700',
    },
    backButton: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backButtonText: {
      color: colors.text,
      fontSize: 32,
      lineHeight: 36,
    },
    spokenWord: {
      color: colors.accent,
      backgroundColor: colors.surface,
      fontWeight: '900',
    },
    bottomBar: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      padding: 14,
      paddingBottom: 18,
      backgroundColor: colors.surface,
      borderTopColor: colors.border,
      borderTopWidth: 1,
      gap: 10,
    },
    status: {
      color: colors.text,
      fontSize: 14,
      textAlign: 'center',
    },
    controls: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
    },
    iconButton: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconButtonText: {
      color: colors.text,
      fontSize: 32,
      lineHeight: 36,
    },
    playButton: {
      minWidth: 140,
      minHeight: 50,
      borderRadius: 25,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 20,
    },
    playButtonText: {
      color: colors.accentText,
      fontWeight: '800',
      fontSize: 16,
    },
    optionsRow: {
      flexDirection: 'row',
      gap: 8,
    },
    optionBox: {
      flex: 1,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      backgroundColor: colors.bg,
    },
    optionLabel: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: '800',
      textTransform: 'uppercase',
      textAlign: 'center',
      marginBottom: 4,
    },
    optionValue: {
      color: colors.text,
      fontWeight: '800',
      fontSize: 13,
      minWidth: 62,
      textAlign: 'center',
    },
    stepperRow: {
      minHeight: 28,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    stepperText: {
      color: colors.accent,
      fontSize: 22,
      fontWeight: '900',
      minWidth: 24,
      textAlign: 'center',
    },
    logButton: {
      width: 58,
      borderRadius: 8,
      backgroundColor: colors.surface2,
      borderColor: colors.border,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    logButtonWide: {
      minHeight: 42,
      borderRadius: 8,
      backgroundColor: colors.bg,
      borderColor: colors.border,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    logButtonText: {
      color: colors.accent,
      fontSize: 13,
      fontWeight: '800',
    },
    meta: {
      color: colors.muted,
      textAlign: 'center',
      fontSize: 12,
      fontVariant: ['tabular-nums'],
    },
    disabled: {
      opacity: 0.45,
    },
  });
}

export default App;
