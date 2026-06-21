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

type PdfViewProps = {
  bookId: string;
  pageCount: number;
  currentPage: number;
  colors: {
    bg: string;
    surface: string;
    surface2: string;
    text: string;
    muted: string;
    border: string;
    accent2: string;
  };
  onSelectPage: (page: number) => void;
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
  colors,
  onError,
}: {
  bookId: string;
  pageIndex: number;
  total: number;
  active: boolean;
  colors: PdfViewProps['colors'];
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
        <Image
          source={{uri: page.uri}}
          style={{width: displayWidth, height}}
          resizeMode="contain"
        />
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

function PdfView({bookId, pageCount, currentPage, colors, onSelectPage, onError}: PdfViewProps) {
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
      extraData={currentPage}
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
        <Pressable onPress={() => onSelectPage(item)}>
          <PdfPage
            bookId={bookId}
            pageIndex={item}
            total={pageCount}
            active={item === currentPage}
            colors={colors}
            onError={onError}
          />
        </Pressable>
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
