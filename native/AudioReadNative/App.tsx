import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  LayoutChangeEvent,
  NativeModules,
  Pressable,
  SafeAreaView,
  ScrollView,
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
};

type PickedDocument = {
  title: string;
  text: string;
  uri: string;
  kind: 'pdf' | 'epub' | 'text';
};

type KokoroTtsModule = {
  initialize(): Promise<InitResult>;
  speak(text: string, speakerId: number, speed: number): Promise<SpeakResult>;
  stop(): Promise<void>;
  record(message: string): Promise<void>;
  exportLogs(): Promise<string>;
};

type DocumentReaderModule = {
  pickDocument(): Promise<PickedDocument>;
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

const SAMPLE_TEXT =
  'Open a PDF or EPUB to start reading. Audio Read will highlight the current sentence as Kokoro reads through the document.';

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

function App() {
  const dark = useColorScheme() === 'dark';
  const colors = dark ? darkColors : lightColors;
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [documentTitle, setDocumentTitle] = useState('Sample');
  const [documentKind, setDocumentKind] = useState<'pdf' | 'epub' | 'text' | 'sample'>('sample');
  const [sentences, setSentences] = useState<Sentence[]>(() => splitSentences(SAMPLE_TEXT));
  const [current, setCurrent] = useState(0);
  const [speakerId, setSpeakerId] = useState(2);
  const [speed, setSpeed] = useState(1);
  const [ready, setReady] = useState<InitResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Open a PDF or EPUB to begin');
  const [lastResult, setLastResult] = useState<SpeakResult | null>(null);
  const playTokenRef = useRef(0);
  const scrollRef = useRef<ScrollView>(null);
  const sentenceYRef = useRef<Record<number, number>>({});

  useEffect(() => {
    recordLog('reader app mounted');
  }, []);

  useEffect(() => {
    const y = sentenceYRef.current[current];
    if (typeof y === 'number') {
      scrollRef.current?.scrollTo({y: Math.max(0, y - 80), animated: true});
    }
  }, [current]);

  const progress = sentences.length ? Math.round(((current + 1) / sentences.length) * 100) : 0;

  const ensureReady = async () => {
    if (ready) return ready;
    setStatus('Loading Kokoro model...');
    const info = await KokoroTts.initialize();
    setReady(info);
    setStatus(`Kokoro ready: ${info.sampleRate} Hz`);
    return info;
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
      setPlaying(false);
      setDocumentTitle(doc.title);
      setDocumentKind(doc.kind);
      sentenceYRef.current = {};
      setSentences(parsed);
      setCurrent(0);
      setLastResult(null);
      setStatus(`${doc.kind.toUpperCase()} loaded: ${parsed.length} sentences`);
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

  const speakAt = async (startIndex: number) => {
    if (!sentences.length) return;
    const token = ++playTokenRef.current;
    setPlaying(true);
    setBusy(true);
    try {
      await ensureReady();
      for (let index = startIndex; index < sentences.length; index++) {
        if (token !== playTokenRef.current) return;
        const sentence = sentences[index];
        setCurrent(index);
        setStatus(`Reading ${index + 1} of ${sentences.length}`);
        recordLog(`ui reading sentence=${index} chars=${sentence.text.length}`);
        const result = await KokoroTts.speak(sentence.text, speakerId, speed);
        if (token !== playTokenRef.current) return;
        setLastResult(result);
      }
      setStatus('Finished');
      setPlaying(false);
    } catch (error) {
      const message = describeError(error);
      setStatus('Playback failed');
      setPlaying(false);
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
      setStatus('Paused');
      return;
    }
    recordLog(`ui play pressed current=${current}`);
    void speakAt(current);
  };

  const jump = async (next: number) => {
    const bounded = Math.max(0, Math.min(sentences.length - 1, next));
    recordLog(`ui jump ${current}->${bounded}`);
    playTokenRef.current++;
    await KokoroTts.stop();
    setCurrent(bounded);
    setPlaying(false);
    setBusy(false);
    setStatus(`Ready at ${bounded + 1} of ${sentences.length}`);
  };

  const exportLogs = async () => {
    try {
      recordLog('ui export logs pressed');
      await KokoroTts.exportLogs();
    } catch (error) {
      Alert.alert('Could not export logs', describeError(error));
    }
  };

  const recordSentenceLayout = (id: number, event: LayoutChangeEvent) => {
    sentenceYRef.current[id] = event.nativeEvent.layout.y;
  };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />
      <View style={styles.header}>
        <View style={styles.logo}>
          <Text style={styles.logoText}>AR</Text>
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>Audio Read</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {documentTitle} · {documentKind.toUpperCase()}
          </Text>
        </View>
        <Pressable style={[styles.openButton, busy && styles.disabled]} onPress={openDocument} disabled={busy}>
          <Text style={styles.openButtonText}>Open</Text>
        </Pressable>
      </View>

      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, {width: `${progress}%`}]} />
      </View>

      <ScrollView ref={scrollRef} contentContainerStyle={styles.readerContent}>
        {sentences.map(sentence => (
          <Pressable
            key={sentence.id}
            onPress={() => jump(sentence.id)}
            onLayout={event => recordSentenceLayout(sentence.id, event)}>
            <Text style={[styles.sentence, sentence.id === current && styles.currentSentence]}>
              {sentence.text}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={styles.bottomBar}>
        <Text style={styles.status} numberOfLines={2}>
          {status}
        </Text>

        <View style={styles.controls}>
          <Pressable style={styles.iconButton} onPress={() => jump(current - 1)} disabled={busy || current === 0}>
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
            onPress={() => jump(current + 1)}
            disabled={busy || current >= sentences.length - 1}>
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
  bg: '#f5f3ee',
  surface: '#fffdf8',
  surface2: '#ebe7df',
  text: '#202124',
  muted: '#6f6b63',
  border: '#ddd6c8',
  accent: '#155e75',
  accent2: '#d97706',
  accentText: '#ffffff',
  highlight: '#fff2bf',
};

const darkColors = {
  bg: '#101413',
  surface: '#171c1b',
  surface2: '#26302e',
  text: '#f4f1ea',
  muted: '#aaa49a',
  border: '#303936',
  accent: '#22d3ee',
  accent2: '#f59e0b',
  accentText: '#062426',
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
