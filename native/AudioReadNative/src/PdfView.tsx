import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Image,
  NativeModules,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type RenderedPage = {
  uri: string;
  width: number;
  height: number;
};

type DocumentReaderModule = {
  renderPdfPage(id: string, pageIndex: number, targetWidth: number): Promise<RenderedPage>;
};

const DocumentReader = NativeModules.DocumentReader as DocumentReaderModule;

type PdfRect = {x: number; y: number; w: number; h: number};
type PdfWord = {x: number; y: number; w: number; h: number; start: number; end: number};
type PdfBox = {page: number; rects: PdfRect[]; words: PdfWord[]};

// Graceful, Speechify-like blue: a soft block behind the whole paragraph and a stronger
// fill on the word being spoken. PDFs render on white, so these read well in both themes.
const BLOCK_COLOR = 'rgba(74,144,255,0.16)';
const WORD_COLOR = 'rgba(74,144,255,0.42)';

type PdfViewProps = {
  bookId: string;
  pageCount: number;
  currentPage: number;
  activeBox?: PdfBox | null;
  activeWordStart?: number;
  activeWordIndex?: number;
  colors: {
    bg: string;
    surface: string;
    surface2: string;
    text: string;
    muted: string;
    border: string;
    accent2: string;
  };
  onSeekToPoint: (page: number, nx: number, ny: number) => void;
  onError?: (message: string) => void;
};

const screenWidth = Dimensions.get('window').width;
// Render at device pixel density for crisp pages, capped to keep memory sane.
const targetWidth = Math.min(1600, Math.round((screenWidth - 16) * PixelRatio.get()));
const displayWidth = screenWidth - 16;
const estimatedPageHeight = displayWidth * 1.414 + 12; // assume ~A4 aspect for layout

function PdfPage({
  bookId,
  pageIndex,
  total,
  active,
  activeBox,
  activeWordStart,
  activeWordIndex,
  colors,
  onTap,
  onError,
}: {
  bookId: string;
  pageIndex: number;
  total: number;
  active: boolean;
  activeBox?: PdfBox | null;
  activeWordStart?: number;
  activeWordIndex?: number;
  colors: PdfViewProps['colors'];
  onTap?: (nx: number, ny: number) => void;
  onError?: (message: string) => void;
}) {
  const [page, setPage] = useState<RenderedPage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    DocumentReader.renderPdfPage(bookId, pageIndex, targetWidth)
      .then(result => {
        if (mounted) setPage(result);
      })
      .catch(error => {
        if (mounted) setFailed(true);
        onError?.(`Page ${pageIndex + 1}: ${String(error?.message ?? error)}`);
      });
    return () => {
      mounted = false;
    };
  }, [bookId, pageIndex, onError]);

  const aspect = page ? page.width / page.height : 1 / 1.414;
  const height = displayWidth / aspect;

  return (
    <View
      style={[
        styles.pageWrap,
        {
          backgroundColor: colors.surface,
          borderColor: active ? colors.accent2 : colors.border,
          borderWidth: active ? 3 : StyleSheet.hairlineWidth,
        },
      ]}>
      {active ? (
        <View style={[styles.readingBadge, {backgroundColor: colors.accent2}]}>
          <Text style={styles.readingBadgeText}>▶ Reading</Text>
        </View>
      ) : null}
      {page ? (
        <Pressable
          onPress={e => {
            const {locationX, locationY} = e.nativeEvent;
            onTap?.(
              Math.min(1, Math.max(0, locationX / displayWidth)),
              Math.min(1, Math.max(0, locationY / height)),
            );
          }}>
          <View style={{width: displayWidth, height}}>
            <Image
              source={{uri: page.uri}}
              style={{width: displayWidth, height}}
              resizeMode="contain"
            />
            {active && activeBox ? (
              <>
                {activeBox.rects.map((r, i) =>
                  r.w > 0 && r.h > 0 ? (
                    <View
                      key={`r${i}`}
                      pointerEvents="none"
                      style={[
                        styles.highlight,
                        {
                          left: r.x * displayWidth,
                          top: r.y * height,
                          width: r.w * displayWidth,
                          height: r.h * height,
                          backgroundColor: BLOCK_COLOR,
                        },
                      ]}
                    />
                  ) : null,
                )}
                {(() => {
                  // Prefer the exact word from TTS onRangeStart; fall back to the timing
                  // estimate (activeWordIndex) when the engine doesn't report ranges.
                  const ws = activeWordStart ?? -1;
                  const words = activeBox.words;
                  let word =
                    ws >= 0 ? words.find(w => ws >= w.start && ws < w.end) : undefined;
                  if (!word) {
                    const idx = activeWordIndex ?? -1;
                    if (idx >= 0 && idx < words.length) word = words[idx];
                  }
                  if (!word || word.w <= 0 || word.h <= 0) return null;
                  return (
                    <View
                      pointerEvents="none"
                      style={[
                        styles.highlight,
                        {
                          left: word.x * displayWidth,
                          top: word.y * height,
                          width: word.w * displayWidth,
                          height: word.h * height,
                          backgroundColor: WORD_COLOR,
                        },
                      ]}
                    />
                  );
                })()}
              </>
            ) : null}
          </View>
        </Pressable>
      ) : (
        <View style={[styles.placeholder, {height: estimatedPageHeight}]}>
          {failed ? (
            <Text style={{color: colors.muted}}>Page {pageIndex + 1} unavailable</Text>
          ) : (
            <ActivityIndicator color={colors.accent2} />
          )}
        </View>
      )}
      <Text style={[styles.pageNumber, {color: colors.muted}]}>
        {pageIndex + 1} / {total}
      </Text>
    </View>
  );
}

function PdfView({
  bookId,
  pageCount,
  currentPage,
  activeBox,
  activeWordStart,
  activeWordIndex,
  colors,
  onSeekToPoint,
  onError,
}: PdfViewProps) {
  const listRef = useRef<FlatList<number>>(null);

  const pages = useMemo(
    () => Array.from({length: Math.max(0, pageCount)}, (_, index) => index),
    [pageCount],
  );

  const getItemLayout = useCallback(
    (_data: ArrayLike<number> | null | undefined, index: number) => ({
      length: estimatedPageHeight + 16,
      offset: (estimatedPageHeight + 16) * index,
      index,
    }),
    [],
  );

  useEffect(() => {
    if (pageCount <= 0) return;
    const bounded = Math.max(0, Math.min(pageCount - 1, currentPage));
    listRef.current?.scrollToIndex({index: bounded, animated: true, viewPosition: 0.05});
  }, [currentPage, pageCount]);

  return (
    <FlatList
      ref={listRef}
      data={pages}
      extraData={`${currentPage}:${
        activeBox && activeBox.rects[0]
          ? `${activeBox.rects[0].y},${activeBox.rects.length}`
          : ''
      }:${activeWordStart ?? -1}:${activeWordIndex ?? -1}`}
      keyExtractor={index => String(index)}
      style={{backgroundColor: colors.bg}}
      contentContainerStyle={styles.content}
      getItemLayout={getItemLayout}
      initialNumToRender={2}
      maxToRenderPerBatch={2}
      windowSize={5}
      removeClippedSubviews
      onScrollToIndexFailed={info => {
        listRef.current?.scrollToOffset({
          offset: (estimatedPageHeight + 16) * info.index,
          animated: false,
        });
      }}
      renderItem={({item}) => (
        <PdfPage
          bookId={bookId}
          pageIndex={item}
          total={pageCount}
          active={item === currentPage}
          activeBox={item === currentPage ? activeBox : null}
          activeWordStart={item === currentPage ? activeWordStart : -1}
          activeWordIndex={item === currentPage ? activeWordIndex : -1}
          colors={colors}
          onTap={(nx, ny) => onSeekToPoint(item, nx, ny)}
          onError={onError}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 8,
    paddingBottom: 240,
    gap: 16,
  },
  pageWrap: {
    borderRadius: 6,
    overflow: 'hidden',
    alignItems: 'center',
  },
  placeholder: {
    width: displayWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageNumber: {
    fontSize: 11,
    paddingVertical: 4,
    fontVariant: ['tabular-nums'],
  },
  highlight: {
    position: 'absolute',
    borderRadius: 2,
  },
  readingBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    zIndex: 2,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  readingBadgeText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
});

export default PdfView;
