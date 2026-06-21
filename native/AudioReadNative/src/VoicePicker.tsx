import React from 'react';
import {FlatList, Modal, Pressable, StyleSheet, Text, View} from 'react-native';

export type TtsVoice = {
  name: string;
  locale: string;
  quality: number;
  label?: string;
  requiresNetwork?: boolean;
  isLocal?: boolean;
};

type VoicePickerProps = {
  visible: boolean;
  voices: TtsVoice[];
  selectedIndex: number;
  colors: {
    bg: string;
    surface: string;
    surface2: string;
    text: string;
    muted: string;
    border: string;
    accent: string;
    accentText: string;
  };
  onSelect: (index: number) => void;
  onClose: () => void;
};

function VoicePicker({visible, voices, selectedIndex, colors, onSelect, onClose}: VoicePickerProps) {
  const styles = makeStyles(colors);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.title}>Choose a voice</Text>
          <Text style={styles.subtitle}>
            {voices.length
              ? 'English voices installed on this device'
              : 'No device voices found. Install more in Android TTS settings.'}
          </Text>
          <FlatList
            data={voices}
            keyExtractor={item => item.name}
            style={styles.list}
            renderItem={({item, index}) => {
              const selected = index === selectedIndex;
              return (
                <Pressable
                  style={[styles.row, selected && styles.rowSelected]}
                  onPress={() => {
                    onSelect(index);
                    onClose();
                  }}>
                  <View style={styles.rowText}>
                    <Text style={[styles.rowLabel, selected && styles.rowLabelSelected]} numberOfLines={1}>
                      {item.label ?? item.locale}
                    </Text>
                    <Text style={styles.rowMeta} numberOfLines={1}>
                      {item.locale}
                      {item.requiresNetwork ? ' · online' : ' · offline'}
                    </Text>
                  </View>
                  {selected ? <Text style={styles.check}>✓</Text> : null}
                </Pressable>
              );
            }}
          />
          <Pressable style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(colors: VoicePickerProps['colors']) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.45)',
      justifyContent: 'flex-end',
    },
    sheet: {
      maxHeight: '72%',
      backgroundColor: colors.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingHorizontal: 18,
      paddingTop: 10,
      paddingBottom: 22,
    },
    handle: {
      alignSelf: 'center',
      width: 42,
      height: 5,
      borderRadius: 3,
      backgroundColor: colors.border,
      marginBottom: 12,
    },
    title: {
      color: colors.text,
      fontSize: 20,
      fontWeight: '900',
    },
    subtitle: {
      color: colors.muted,
      fontSize: 13,
      marginTop: 4,
      marginBottom: 8,
    },
    list: {
      flexGrow: 0,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 10,
      marginVertical: 3,
      backgroundColor: colors.bg,
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
    },
    rowSelected: {
      borderColor: colors.accent,
      borderWidth: 2,
    },
    rowText: {
      flex: 1,
      minWidth: 0,
    },
    rowLabel: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '700',
    },
    rowLabelSelected: {
      color: colors.accent,
    },
    rowMeta: {
      color: colors.muted,
      fontSize: 12,
      marginTop: 2,
    },
    check: {
      color: colors.accent,
      fontSize: 20,
      fontWeight: '900',
    },
    closeButton: {
      marginTop: 12,
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    closeText: {
      color: colors.accentText,
      fontWeight: '800',
      fontSize: 16,
    },
  });
}

export default VoicePicker;
