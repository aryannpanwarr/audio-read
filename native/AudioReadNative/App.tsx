import React, {useEffect, useMemo, useRef, useState} from 'react';
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

type InitResult = {
  sampleRate: number;
  speakers: number;
  model: string;
};

type SpeakResult = {
  elapsedSeconds: number;
  audioDurationSeconds: number;
  rtf: number;
  sampleRate: number;
  samples: number;
  cached?: boolean;
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
  preparedAudioSeconds: number;
  cacheStatus: string;
};

type LoadedLibraryBook = LibraryBook & {
  text: string;
};

type SpeechTiming = {
  audioDurationSeconds: number;
  wordCount: number;
};

type PrebufferProgress = {
  processed: number;
  total: number;
  cacheHits: number;
  audioDurationSeconds: number;
  elapsedSeconds: number;
};

type PrebufferResult = {
  generated: number;
  cacheHits: number;
  audioDurationSeconds: number;
  elapsedSeconds: number;
};

type KokoroTtsModule = {
  initialize(): Promise<InitResult>;
  speak(text: string, speakerId: number, speed: number, nextText: string): Promise<SpeakResult>;
  prebuffer(
    texts: string[],
    speakerId: number,
    speed: number,
    targetAudioSeconds: number,
  ): Promise<PrebufferResult>;
  stop(): Promise<void>;
  startPlaybackSession(): Promise<void>;
  stopPlaybackSession(): Promise<void>;
  notifyPreparationDone(title: string, audioDurationSeconds: number): Promise<void>;
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
};

const KokoroTts = NativeModules.KokoroTts as KokoroTtsModule;
const DocumentReader = NativeModules.DocumentReader as DocumentReaderModule;

declare const global: {
  ErrorUtils?: {
    getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
    setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
  };
};

const VOICES = [
  'Heart',
  'Bella',
  'Nicole',
  'Sarah',
  'Sky',
  'Adam',
  'Michael',
  'Emma',
  'Isabella',
  'George',
  'Lewis',
];

const INITIAL_BUFFER_SECONDS = 18;
const BACKGROUND_BUFFER_SECONDS = 240;
const LIBRARY_PREP_SECONDS = 600;
const MAX_BUFFER_SENTENCES = 160;

const describeError = (error: unknown) => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ''}`;
  }
  return String(error);
};

const recordLog = (message: string) => {
  void KokoroTts.record(message).catch(() => {});
};

const previousErrorHandler = global.ErrorUtils?.getGlobalHandler?.();
global.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
  recordLog(`global-js-error fatal=${Boolean(isFatal)} ${describeError(error)}`);
  previousErrorHandler?.(error, isFatal);
});

type Sentence = {
  id: number;
  text: string;
};

function splitSentences(text: string): Sentence[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const parts = normalized.match(/[^.!?]+[.!?]+["')\]]?|[^.!?]+$/g) ?? [normalized];
  return parts
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .slice(0, 5000)
    .map((part, index) => ({id: index, text: part}));
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function splitWords(text: string) {
  return text.split(/(\s+)/).filter(part => part.length > 0);
}

function isWord(part: string) {
  return /\S/.test(part);
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
  const [speakerId, setSpeakerId] = useState(2);
  const [speed, setSpeed] = useState(0.95);
  const [ready, setReady] = useState<InitResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Library ready');
  const [lastResult, setLastResult] = useState<SpeakResult | null>(null);
  const [activeWordCount, setActiveWordCount] = useState(0);
  const playTokenRef = useRef(0);
  const listRef = useRef<FlatList<Sentence>>(null);
  const commandHandlerRef = useRef<(command: string) => void>(() => {});
  const timingHandlerRef = useRef<(timing: SpeechTiming) => void>(() => {});
  const wordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sentencesRef = useRef(sentences);
  const currentRef = useRef(current);
  const backgroundBufferingRef = useRef(false);
  const visiblePrebufferRef = useRef(false);

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
      if (nextCount >= wordCount) {
        if (wordTimerRef.current) {
          clearInterval(wordTimerRef.current);
          wordTimerRef.current = null;
        }
      }
    }, 80);
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

  useEffect(() => {
    recordLog('reader app mounted');
    void Promise.resolve().then(refreshLibrary);
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      void PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(error => {
        recordLog(`notification permission request failed ${describeError(error)}`);
      });
    }
  }, []);

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.KokoroTts);
    const commandSubscription = emitter.addListener('AudioReadPlaybackCommand', command => {
      recordLog(`ui playback command ${String(command)}`);
      commandHandlerRef.current(String(command));
    });
    const timingSubscription = emitter.addListener('AudioReadSpeechTiming', timing => {
      timingHandlerRef.current(timing as SpeechTiming);
    });
    const prebufferSubscription = emitter.addListener('AudioReadPrebufferProgress', progress => {
      const info = progress as PrebufferProgress;
      if (visiblePrebufferRef.current) {
        setStatus(
          `Preparing ${formatDuration(info.audioDurationSeconds)} audio · ${info.processed}/${info.total}`,
        );
      }
      recordLog(
        `ui prebuffer progress processed=${info.processed}/${info.total} audio=${info.audioDurationSeconds.toFixed(3)}s elapsed=${info.elapsedSeconds.toFixed(3)}s cacheHits=${info.cacheHits}`,
      );
    });
    return () => {
      commandSubscription.remove();
      timingSubscription.remove();
      prebufferSubscription.remove();
      clearWordProgress();
    };
  }, []);

  useEffect(() => {
    sentencesRef.current = sentences;
    currentRef.current = current;
  }, [sentences, current]);

  useEffect(() => {
    if (sentences.length) {
      listRef.current?.scrollToIndex({
        index: current,
        animated: true,
        viewPosition: 0.2,
      });
    }
  }, [current, sentences.length]);

  const progress = sentences.length ? Math.round(((current + 1) / sentences.length) * 100) : 0;

  const ensureReady = async () => {
    if (ready) return ready;
    setStatus('Loading Kokoro model...');
    const info = await KokoroTts.initialize();
    setReady(info);
    setStatus(`Kokoro ready: ${info.sampleRate} Hz`);
    return info;
  };

  const sentenceWindow = (startIndex: number) =>
    sentences.slice(startIndex, startIndex + MAX_BUFFER_SENTENCES).map(sentence => sentence.text);

  const prebufferTexts = async (texts: string[], targetSeconds: number, visible: boolean, label: string) => {
    if (!texts.length) return null;
    visiblePrebufferRef.current = visible;
    try {
      if (visible) setStatus('Preparing audio buffer...');
      const result = await KokoroTts.prebuffer(texts, speakerId, speed, targetSeconds);
      recordLog(
        `ui prebuffer done label=${label} generated=${result.generated} cacheHits=${result.cacheHits} audio=${result.audioDurationSeconds.toFixed(3)}s elapsed=${result.elapsedSeconds.toFixed(3)}s`,
      );
      if (visible) {
        setStatus(`Prepared ${formatDuration(result.audioDurationSeconds)} audio`);
      }
      return result;
    } finally {
      if (visible) {
        visiblePrebufferRef.current = false;
      }
    }
  };

  const prebufferFrom = async (startIndex: number, targetSeconds: number, visible: boolean) =>
    prebufferTexts(sentenceWindow(startIndex), targetSeconds, visible, `start=${startIndex}`);

  const startBackgroundBuffer = (startIndex: number) => {
    if (backgroundBufferingRef.current) return;
    backgroundBufferingRef.current = true;
    void prebufferFrom(startIndex, BACKGROUND_BUFFER_SECONDS, false)
      .catch(error => recordLog(`ui background prebuffer failed ${describeError(error)}`))
      .finally(() => {
        backgroundBufferingRef.current = false;
      });
  };

  const updateBookInState = (book: LibraryBook) => {
    setLibrary(items => [book, ...items.filter(item => item.id !== book.id)]);
  };

  const startDocumentPreparation = (parsed: Sentence[], book: LibraryBook, startIndex = 0) => {
    const texts = parsed.slice(startIndex, startIndex + MAX_BUFFER_SENTENCES).map(sentence => sentence.text);
    if (!texts.length || backgroundBufferingRef.current) return;
    backgroundBufferingRef.current = true;
    void DocumentReader.updateLibraryDocument(book.id, {cacheStatus: 'preparing'}).then(updateBookInState).catch(() => {});
    recordLog(`ui library prepare started title=${book.title} start=${startIndex} sentences=${texts.length}`);
    void ensureReady()
      .then(() => prebufferTexts(texts, LIBRARY_PREP_SECONDS, false, `library=${book.title}`))
      .then(result => {
        if (!result) return;
        recordLog(
          `ui library prepare done title=${book.title} audio=${result.audioDurationSeconds.toFixed(3)}s elapsed=${result.elapsedSeconds.toFixed(3)}s`,
        );
        void DocumentReader.updateLibraryDocument(book.id, {
          cacheStatus: 'ready',
          preparedAudioSeconds: result.audioDurationSeconds,
        })
          .then(updateBookInState)
          .catch(error => recordLog(`ui library prepare metadata update failed ${describeError(error)}`));
        return KokoroTts.notifyPreparationDone(book.title, result.audioDurationSeconds);
      })
      .catch(error => {
        void DocumentReader.updateLibraryDocument(book.id, {cacheStatus: 'failed'}).then(updateBookInState).catch(() => {});
        recordLog(`ui library prepare failed ${describeError(error)}`);
      })
      .finally(() => {
        backgroundBufferingRef.current = false;
      });
  };

  const openDocument = async () => {
    try {
      recordLog('ui open document pressed');
      setBusy(true);
      setStatus('Opening document...');
      const doc = await DocumentReader.pickDocument();
      const parsed = splitSentences(doc.text);
      if (!parsed.length) throw new Error('No readable sentences found in this document');
      playTokenRef.current++;
      await KokoroTts.stop();
      await KokoroTts.stopPlaybackSession();
      clearWordProgress();
      backgroundBufferingRef.current = false;
      const book = await DocumentReader.saveLibraryDocument(
        doc.title,
        doc.kind,
        doc.uri,
        doc.text,
        parsed.length,
      );
      updateBookInState(book);
      setPlaying(false);
      setActiveBookId(book.id);
      setDocumentTitle(doc.title);
      setDocumentKind(doc.kind);
      setSentences(parsed);
      setCurrent(0);
      setLastResult(null);
      setView('reader');
      setStatus(`${doc.kind.toUpperCase()} added: ${parsed.length} sentences · caching in background`);
      recordLog(`ui document loaded title=${doc.title} kind=${doc.kind} sentences=${parsed.length}`);
      startDocumentPreparation(parsed, book, 0);
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
      const parsed = splitSentences(loaded.text);
      if (!parsed.length) throw new Error('No readable sentences found in this book');
      playTokenRef.current++;
      await KokoroTts.stop();
      await KokoroTts.stopPlaybackSession();
      clearWordProgress();
      backgroundBufferingRef.current = false;
      setPlaying(false);
      setActiveBookId(loaded.id);
      setDocumentTitle(loaded.title);
      setDocumentKind(loaded.kind);
      setSentences(parsed);
      const startIndex = Math.max(0, Math.min(parsed.length - 1, loaded.lastPosition || 0));
      setCurrent(startIndex);
      setLastResult(null);
      setView('reader');
      setStatus(`Ready · ${loaded.cacheStatus === 'ready' ? 'cached audio available' : 'caching continues in background'}`);
      startDocumentPreparation(parsed, loaded, startIndex);
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
        playTokenRef.current++;
        await KokoroTts.stop();
        await KokoroTts.stopPlaybackSession();
        clearWordProgress();
        setActiveBookId(null);
        setSentences([]);
        setCurrent(0);
        setPlaying(false);
        setView('library');
      }
      setStatus('Book removed');
    } catch (error) {
      Alert.alert('Could not remove book', describeError(error));
    }
  };

  const speakAt = async (startIndex: number) => {
    if (!sentences.length) return;
    const token = ++playTokenRef.current;
    setPlaying(true);
    setBusy(true);
    try {
      await ensureReady();
      if (backgroundBufferingRef.current) {
        setStatus('Using background preparation...');
      } else {
        await prebufferFrom(startIndex, INITIAL_BUFFER_SECONDS, true);
      }
      if (token !== playTokenRef.current) return;
      await KokoroTts.startPlaybackSession();
      startBackgroundBuffer(startIndex + 1);
      for (let index = startIndex; index < sentences.length; index++) {
        if (token !== playTokenRef.current) return;
        const sentence = sentences[index];
        setCurrent(index);
        if (activeBookId) {
          void DocumentReader.updateLibraryDocument(activeBookId, {lastPosition: index})
            .then(updateBookInState)
            .catch(error => recordLog(`ui progress update failed ${describeError(error)}`));
        }
        setActiveWordCount(0);
        setStatus(`Reading ${index + 1} of ${sentences.length}`);
        recordLog(`ui reading sentence=${index} chars=${sentence.text.length}`);
        const nextSentence = sentences[index + 1]?.text ?? '';
        const result = await KokoroTts.speak(sentence.text, speakerId, speed, nextSentence);
        if (token !== playTokenRef.current) return;
        setLastResult(result);
        recordLog(
          `ui sentence done index=${index} generation=${result.elapsedSeconds.toFixed(3)}s audio=${result.audioDurationSeconds.toFixed(3)}s rtf=${result.rtf.toFixed(3)} cached=${Boolean(result.cached)}`,
        );
        startBackgroundBuffer(index + 2);
      }
      setStatus('Finished');
      setPlaying(false);
      clearWordProgress();
      await KokoroTts.stopPlaybackSession();
    } catch (error) {
      const message = describeError(error);
      setStatus('Playback failed');
      setPlaying(false);
      clearWordProgress();
      await KokoroTts.stopPlaybackSession().catch(() => {});
      Alert.alert('Playback failed', message);
      recordLog(`ui playback failed ${message}`);
    } finally {
      if (token === playTokenRef.current) {
        setBusy(false);
      }
    }
  };

  const playPause = async () => {
    if (busy && !playing) return;
    if (playing) {
      recordLog('ui pause pressed');
      playTokenRef.current++;
      setPlaying(false);
      setBusy(false);
      await KokoroTts.stop();
      await KokoroTts.stopPlaybackSession();
      clearWordProgress();
      backgroundBufferingRef.current = false;
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
    playTokenRef.current++;
    await KokoroTts.stop();
    clearWordProgress();
    backgroundBufferingRef.current = false;
    setCurrent(bounded);
    if (activeBookId) {
      void DocumentReader.updateLibraryDocument(activeBookId, {lastPosition: bounded})
        .then(updateBookInState)
        .catch(error => recordLog(`ui progress update failed ${describeError(error)}`));
    }
    setPlaying(false);
    setBusy(false);
    if (shouldResume) {
      void speakAt(bounded);
    } else {
      await KokoroTts.stopPlaybackSession();
      setStatus(`Ready at ${bounded + 1} of ${sentences.length}`);
    }
  };

  const exportLogs = async () => {
    try {
      recordLog('ui export logs pressed');
      await KokoroTts.exportLogs();
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

  const renderBookItem = ({item}: {item: LibraryBook}) => {
    const cached = item.cacheStatus === 'ready';
    return (
      <Pressable style={styles.bookRow} onPress={() => openLibraryBook(item)}>
        <View style={styles.bookCover}>
          <Text style={styles.bookCoverText}>{item.kind.toUpperCase()}</Text>
        </View>
        <View style={styles.bookInfo}>
          <Text style={styles.bookTitle} numberOfLines={2}>
            {item.title}
          </Text>
          <Text style={styles.bookMeta} numberOfLines={1}>
            {item.sentenceCount} sentences · {bookProgress(item)}% read
          </Text>
          <View style={styles.bookProgressTrack}>
            <View style={[styles.bookProgressFill, {width: `${bookProgress(item)}%`}]} />
          </View>
          <Text style={[styles.cachePill, cached && styles.cachePillReady]} numberOfLines={1}>
            {cached
              ? `${formatDuration(item.preparedAudioSeconds)} cached`
              : item.cacheStatus === 'preparing'
                ? 'Caching in background'
                : 'Cache pending'}
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
          <Text style={styles.deleteButtonText}>×</Text>
        </Pressable>
      </Pressable>
    );
  };

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
            {documentKind.toUpperCase()} · {sentences.length} sentences
          </Text>
        </View>
        <Pressable style={[styles.openButton, busy && styles.disabled]} onPress={openDocument} disabled={busy}>
          <Text style={styles.openButtonText}>Import</Text>
        </Pressable>
      </View>

      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, {width: `${progress}%`}]} />
      </View>

      <FlatList
        ref={listRef}
        data={sentences}
        keyExtractor={item => String(item.id)}
        renderItem={renderSentenceItem}
        contentContainerStyle={styles.readerContent}
        initialNumToRender={18}
        maxToRenderPerBatch={12}
        windowSize={9}
        removeClippedSubviews
        onScrollToIndexFailed={handleScrollToIndexFailed}
      />

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
            <Text style={styles.playButtonText}>{playing ? 'Pause' : ready ? 'Play' : 'Load & Play'}</Text>
          </Pressable>
          <Pressable
            style={styles.iconButton}
            onPress={() => skipTo(current + 1)}
            disabled={(busy && !playing) || current >= sentences.length - 1}>
            <Text style={styles.iconButtonText}>›</Text>
          </Pressable>
        </View>

        <View style={styles.optionsRow}>
          <View style={styles.optionBox}>
            <Text style={styles.optionLabel}>Voice</Text>
            <View style={styles.stepperRow}>
              <Pressable onPress={() => setSpeakerId(Math.max(0, speakerId - 1))} disabled={playing}>
                <Text style={styles.stepperText}>-</Text>
              </Pressable>
              <Text style={styles.optionValue}>{VOICES[speakerId] ?? speakerId}</Text>
              <Pressable onPress={() => setSpeakerId(Math.min(10, speakerId + 1))} disabled={playing}>
                <Text style={styles.stepperText}>+</Text>
              </Pressable>
            </View>
          </View>
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
                onPress={() => setSpeed(Math.min(1.5, Number((speed + 0.1).toFixed(1))))}
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
          {sentences.length ? `${current + 1}/${sentences.length}` : '0/0'}
          {lastResult ? ` · RTF ${lastResult.rtf.toFixed(2)} · ${formatDuration(lastResult.audioDurationSeconds)}` : ''}
        </Text>
      </View>
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
    logo: {
      width: 42,
      height: 42,
      borderRadius: 10,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    logoText: {
      color: colors.accentText,
      fontWeight: '800',
      fontSize: 16,
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
    cachePill: {
      alignSelf: 'flex-start',
      maxWidth: '100%',
      color: colors.muted,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
      fontSize: 11,
      fontWeight: '800',
    },
    cachePillReady: {
      color: colors.accent,
      borderColor: colors.accent,
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
      fontSize: 24,
      lineHeight: 26,
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
    readerContent: {
      padding: 22,
      paddingBottom: 260,
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
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    stepperText: {
      color: colors.accent,
      fontSize: 22,
      fontWeight: '900',
      paddingHorizontal: 6,
    },
    logButton: {
      width: 64,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.bg,
    },
    logButtonWide: {
      minHeight: 42,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.bg,
    },
    logButtonText: {
      color: colors.accent,
      fontWeight: '800',
      fontSize: 13,
    },
    meta: {
      color: colors.muted,
      fontSize: 12,
      textAlign: 'center',
      fontVariant: ['tabular-nums'],
    },
    disabled: {
      opacity: 0.5,
    },
  });
}

export default App;
