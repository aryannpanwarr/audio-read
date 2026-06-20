import React, {useMemo, useState} from 'react';
import {
  Alert,
  NativeModules,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
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

type KokoroTtsModule = {
  initialize(): Promise<InitResult>;
  speak(text: string, speakerId: number, speed: number): Promise<SpeakResult>;
  stop(): Promise<void>;
};

const KokoroTts = NativeModules.KokoroTts as KokoroTtsModule;

const SAMPLE =
  'Today as always, men fall into two groups: slaves and free men. Whoever does not have two-thirds of his day for himself, is a slave.';

const VOICES = [
  'af',
  'af_bella',
  'af_nicole',
  'af_sarah',
  'af_sky',
  'am_adam',
  'am_michael',
  'bf_emma',
  'bf_isabella',
  'bm_george',
  'bm_lewis',
];

function App() {
  const dark = useColorScheme() === 'dark';
  const colors = dark ? darkColors : lightColors;
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [text, setText] = useState(SAMPLE);
  const [speakerId, setSpeakerId] = useState(2);
  const [speed, setSpeed] = useState(1);
  const [ready, setReady] = useState<InitResult | null>(null);
  const [result, setResult] = useState<SpeakResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Not initialized');

  const initialize = async () => {
    try {
      setBusy(true);
      setStatus('Loading Kokoro model...');
      const info = await KokoroTts.initialize();
      setReady(info);
      setStatus(`Ready: ${info.model}, ${info.sampleRate} Hz, ${info.speakers} voices`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus('Initialization failed');
      Alert.alert('Kokoro failed to initialize', message);
    } finally {
      setBusy(false);
    }
  };

  const speak = async () => {
    try {
      setBusy(true);
      setResult(null);
      setStatus('Synthesizing and streaming audio...');
      const metrics = await KokoroTts.speak(text, speakerId, speed);
      setResult(metrics);
      setStatus(metrics.rtf < 1 ? 'Pass: faster than real time' : 'Slow: slower than playback');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus('Synthesis failed');
      Alert.alert('Kokoro synthesis failed', message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    await KokoroTts.stop();
    setBusy(false);
    setStatus('Stopped');
  };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Audio Read Native</Text>
        <Text style={styles.subtitle}>Kokoro on-device benchmark for OnePlus 11R</Text>

        <View style={styles.panel}>
          <Text style={styles.label}>Text</Text>
          <TextInput
            multiline
            value={text}
            onChangeText={setText}
            style={styles.input}
            placeholder="Enter text to synthesize"
            placeholderTextColor={colors.muted}
          />
        </View>

        <View style={styles.row}>
          <View style={styles.stepper}>
            <Text style={styles.label}>Voice</Text>
            <View style={styles.stepperRow}>
              <Pressable
                style={styles.smallButton}
                onPress={() => setSpeakerId(Math.max(0, speakerId - 1))}
                disabled={busy}>
                <Text style={styles.buttonText}>-</Text>
              </Pressable>
              <Text style={styles.value}>
                {speakerId} {VOICES[speakerId] ?? ''}
              </Text>
              <Pressable
                style={styles.smallButton}
                onPress={() => setSpeakerId(Math.min(10, speakerId + 1))}
                disabled={busy}>
                <Text style={styles.buttonText}>+</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.stepper}>
            <Text style={styles.label}>Speed</Text>
            <View style={styles.stepperRow}>
              <Pressable
                style={styles.smallButton}
                onPress={() => setSpeed(Math.max(0.5, Number((speed - 0.1).toFixed(1))))}
                disabled={busy}>
                <Text style={styles.buttonText}>-</Text>
              </Pressable>
              <Text style={styles.value}>{speed.toFixed(1)}x</Text>
              <Pressable
                style={styles.smallButton}
                onPress={() => setSpeed(Math.min(2, Number((speed + 0.1).toFixed(1))))}
                disabled={busy}>
                <Text style={styles.buttonText}>+</Text>
              </Pressable>
            </View>
          </View>
        </View>

        <View style={styles.actions}>
          <Pressable style={[styles.button, busy && styles.disabled]} onPress={initialize} disabled={busy}>
            <Text style={styles.buttonText}>{ready ? 'Reload Model' : 'Initialize'}</Text>
          </Pressable>
          <Pressable
            style={[styles.button, (!ready || busy) && styles.disabled]}
            onPress={speak}
            disabled={!ready || busy}>
            <Text style={styles.buttonText}>Speak</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={stop}>
            <Text style={styles.secondaryButtonText}>Stop</Text>
          </Pressable>
        </View>

        <View style={styles.panel}>
          <Text style={styles.label}>Status</Text>
          <Text style={styles.status}>{status}</Text>
          {result && (
            <View style={styles.metrics}>
              <Text style={styles.metric}>Elapsed: {result.elapsedSeconds.toFixed(2)}s</Text>
              <Text style={styles.metric}>Audio: {result.audioDurationSeconds.toFixed(2)}s</Text>
              <Text style={[styles.metric, result.rtf < 1 ? styles.good : styles.bad]}>
                RTF: {result.rtf.toFixed(2)} {result.rtf < 1 ? '(good)' : '(too slow)'}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const lightColors = {
  bg: '#f7f7f4',
  panel: '#ffffff',
  text: '#1f2430',
  muted: '#6b7280',
  border: '#deded8',
  accent: '#2563eb',
  accentText: '#ffffff',
  good: '#047857',
  bad: '#b91c1c',
};

const darkColors = {
  bg: '#111315',
  panel: '#1b1f23',
  text: '#f3f4f6',
  muted: '#9ca3af',
  border: '#31363d',
  accent: '#3b82f6',
  accentText: '#ffffff',
  good: '#34d399',
  bad: '#f87171',
};

function makeStyles(colors: typeof lightColors) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    content: {
      padding: 20,
      gap: 16,
    },
    title: {
      color: colors.text,
      fontSize: 28,
      fontWeight: '700',
    },
    subtitle: {
      color: colors.muted,
      fontSize: 15,
      marginTop: -8,
    },
    panel: {
      backgroundColor: colors.panel,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 14,
      gap: 8,
    },
    label: {
      color: colors.muted,
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
    },
    input: {
      minHeight: 150,
      color: colors.text,
      fontSize: 17,
      lineHeight: 24,
      textAlignVertical: 'top',
    },
    row: {
      flexDirection: 'row',
      gap: 12,
    },
    stepper: {
      flex: 1,
      backgroundColor: colors.panel,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 14,
      gap: 10,
    },
    stepperRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    value: {
      flex: 1,
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
      textAlign: 'center',
    },
    actions: {
      flexDirection: 'row',
      gap: 10,
    },
    button: {
      flex: 1,
      minHeight: 48,
      backgroundColor: colors.accent,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 12,
    },
    smallButton: {
      width: 38,
      height: 38,
      backgroundColor: colors.accent,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryButton: {
      minHeight: 48,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 18,
    },
    buttonText: {
      color: colors.accentText,
      fontSize: 16,
      fontWeight: '700',
    },
    secondaryButtonText: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '700',
    },
    disabled: {
      opacity: 0.45,
    },
    status: {
      color: colors.text,
      fontSize: 16,
    },
    metrics: {
      marginTop: 8,
      gap: 4,
    },
    metric: {
      color: colors.text,
      fontSize: 15,
      fontVariant: ['tabular-nums'],
    },
    good: {
      color: colors.good,
      fontWeight: '700',
    },
    bad: {
      color: colors.bad,
      fontWeight: '700',
    },
  });
}

export default App;
