// nitpick's Inspect library (ADR-0015). The server compiles it on the Device
// Host and loads it into an iOS Build at launch with
// SIMCTL_CHILD_DYLD_INSERT_LIBRARIES; the Build needs no change.
//
// It switches on SwiftUI's view debug data, then answers one request on the
// simulator's loopback, on the port the server chose for this launch, and
// only with the secret the server chose for it:
//
//   GET /layout   Authorization: Bearer <secret>
//
// The answer is JSON: the screen, then each SwiftUI hosting view on screen in
// paint order, back to front, with its frame in screen points, what the tree
// names by address but doesn't describe (texts TextKit 2 lays out, fonts),
// and the bytes SwiftUI's own -makeViewDebugData returned, passed through
// unparsed. The tree nests hundreds of levels, which once overflowed a
// thread's stack when it was parsed here; the server reads it
// (server/src/device/layoutSnapshot.ts).
//
// Whatever fails answers an error; nothing here may take the Build down.

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <arpa/inet.h>
#include <malloc/malloc.h>
#include <netinet/in.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

// type, value, transform, position and size (_ViewDebug.Property 0 to 4).
static const char *const ViewDebugProperties = "31";

static NSString *Secret;

static void Log(NSString *message) {
    NSLog(@"[nitpick inspect] %@", message);
}

#pragma mark - Hosting views on screen

static CGRect ScreenFrame(UIView *view) {
    return [view convertRect:view.bounds toCoordinateSpace:view.window.screen.coordinateSpace];
}

static void CollectHostingViews(UIView *view, NSMutableArray<UIView *> *found) {
    if ([view respondsToSelector:NSSelectorFromString(@"makeViewDebugData")]) {
        [found addObject:view];
    }
    for (UIView *subview in view.subviews) CollectHostingViews(subview, found);
}

/** Drawn at all: in a window, and neither it nor an ancestor hidden or clear. */
static BOOL IsShown(UIView *view) {
    if (view.window == nil) return NO;
    for (UIView *each = view; each != nil; each = each.superview) {
        if (each.hidden || each.alpha < 0.01) return NO;
    }
    return YES;
}

/** Its own background fills its frame: nothing behind it shows through. */
static BOOL IsOpaque(UIView *view) {
    UIColor *background = [view.backgroundColor resolvedColorWithTraitCollection:view.traitCollection];
    CGFloat red = 0, green = 0, blue = 0, alpha = 0;
    return background != nil && [background getRed:&red green:&green blue:&blue alpha:&alpha] && alpha >= 1;
}

/**
 * The hosting views a Reviewer sees, back to front: windows by level, and
 * within one the order UIKit draws its subviews in. A hosting view drops out
 * when it isn't drawn, lies off screen, or an opaque hosting view drawn after
 * it covers its whole frame, as a full-screen cover covers the screen it
 * was presented from; a sheet covers only part of its presenter, which stays.
 */
static NSArray<UIView *> *VisibleHostingViews(CGRect screen) {
    NSMutableArray<UIWindow *> *windows = [NSMutableArray array];
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        if (scene.activationState == UISceneActivationStateBackground) continue;
        for (UIWindow *window in ((UIWindowScene *)scene).windows) {
            if (!window.hidden) [windows addObject:window];
        }
    }
    [windows sortWithOptions:NSSortStable usingComparator:^NSComparisonResult(UIWindow *a, UIWindow *b) {
        return a.windowLevel < b.windowLevel ? NSOrderedAscending
             : a.windowLevel > b.windowLevel ? NSOrderedDescending : NSOrderedSame;
    }];
    NSMutableArray<UIView *> *drawn = [NSMutableArray array];
    for (UIWindow *window in windows) CollectHostingViews(window, drawn);

    NSMutableArray<UIView *> *shown = [NSMutableArray array];
    for (UIView *view in drawn) {
        if (!IsShown(view)) continue;
        CGRect frame = ScreenFrame(view);
        if (CGRectIntersectsRect(frame, screen) && !CGRectIsEmpty(frame)) [shown addObject:view];
    }
    NSMutableArray<UIView *> *visible = [NSMutableArray array];
    for (NSUInteger index = 0; index < shown.count; index++) {
        CGRect frame = ScreenFrame(shown[index]);
        BOOL covered = NO;
        for (NSUInteger above = index + 1; above < shown.count && !covered; above++) {
            UIView *cover = shown[above];
            covered = IsOpaque(cover) && CGRectContainsRect(CGRectInset(ScreenFrame(cover), -0.5, -0.5), frame);
        }
        if (!covered) [visible addObject:shown[index]];
    }
    return visible;
}

#pragma mark - Text attributes

/** Extended sRGB components, which may leave 0…1 for wide colours. */
static id ColorComponents(id color) {
    if (![color isKindOfClass:UIColor.class]) return nil;
    CGFloat red = 0, green = 0, blue = 0, alpha = 0;
    if (![(UIColor *)color getRed:&red green:&green blue:&blue alpha:&alpha]) return nil;
    return @[@(red), @(green), @(blue), @(alpha)];
}

/**
 * The object at an address the tree printed, if it is still there: the start
 * of a live allocation whose class is exactly the one printed beside it.
 * Only then is it messaged. Read on the main thread straight after the dump,
 * so the objects SwiftUI just described are still alive.
 */
static id ObjectAt(uintptr_t address, Class printed) {
    if (printed == Nil || address == 0 || address % sizeof(void *) != 0) return nil;
    void *pointer = (void *)address;
    if (malloc_zone_from_ptr(pointer) == NULL) return nil;
    if (malloc_size(pointer) < class_getInstanceSize(printed)) return nil;
    __unsafe_unretained id object = (__bridge id)pointer;
    if (object_getClass(object) != printed) return nil;
    return object;
}

static NSDictionary *FontAttributes(UIFont *font) {
    NSDictionary *traits = [font.fontDescriptor objectForKey:UIFontDescriptorTraitsAttribute];
    id weight = traits[UIFontWeightTrait];
    return @{
        @"name": font.fontName ?: @"",
        @"family": font.familyName ?: @"",
        @"size": @(font.pointSize),
        @"weight": [weight isKindOfClass:NSNumber.class] ? weight : @0,
        @"lineHeight": @(font.lineHeight),
    };
}

/** A text TextKit 2 lays out: its runs with their resolved attributes. */
static NSArray *TextAttributes(NSTextContentStorage *storage) {
    NSAttributedString *text = storage.attributedString;
    if (text == nil) return nil;
    NSMutableArray *runs = [NSMutableArray array];
    [text enumerateAttributesInRange:NSMakeRange(0, text.length) options:0
                          usingBlock:^(NSDictionary *attributes, NSRange range, BOOL *stop) {
        NSMutableDictionary *run = [NSMutableDictionary dictionary];
        run[@"text"] = [text.string substringWithRange:range];
        UIFont *font = attributes[NSFontAttributeName];
        if ([font isKindOfClass:UIFont.class]) run[@"font"] = FontAttributes(font);
        id color = ColorComponents(attributes[NSForegroundColorAttributeName]);
        if (color != nil) run[@"color"] = color;
        id kern = attributes[NSKernAttributeName];
        if ([kern isKindOfClass:NSNumber.class]) run[@"kern"] = kern;
        id tracking = attributes[NSTrackingAttributeName];
        if ([tracking isKindOfClass:NSNumber.class]) run[@"tracking"] = tracking;
        NSParagraphStyle *paragraph = attributes[NSParagraphStyleAttributeName];
        if ([paragraph isKindOfClass:NSParagraphStyle.class]) {
            run[@"paragraph"] = @{
                @"lineSpacing": @(paragraph.lineSpacing),
                @"minimumLineHeight": @(paragraph.minimumLineHeight),
                @"maximumLineHeight": @(paragraph.maximumLineHeight),
            };
        }
        [runs addObject:run];
    }];
    return runs;
}

/**
 * Calls `resolve` once for each distinct address the tree's bytes print
 * after `marker`, keyed by the address as printed.
 */
static NSDictionary *Resolve(NSData *tree, const char *marker, id (^resolve)(uintptr_t)) {
    size_t markerLength = strlen(marker);
    NSMutableDictionary *resolved = [NSMutableDictionary dictionary];
    NSMutableSet *seen = [NSMutableSet set];
    const char *end = (const char *)tree.bytes + tree.length;
    const char *cursor = tree.bytes;
    while (cursor < end) {
        const char *found = memmem(cursor, (size_t)(end - cursor), marker, markerLength);
        if (found == NULL) break;
        const char *digits = found + markerLength;
        const char *after = digits;
        uintptr_t address = 0;
        while (after < end && after - digits < 16 && isxdigit((unsigned char)*after)) {
            address = address * 16 + (uintptr_t)digittoint(*after);
            after++;
        }
        cursor = after;
        NSString *key = [NSString stringWithFormat:@"0x%.*s", (int)(after - digits), digits];
        if ([seen containsObject:key]) continue;
        [seen addObject:key];
        id value = resolve(address);
        if (value != nil) resolved[key] = value;
    }
    return resolved;
}

/**
 * What the tree names by address but doesn't describe: the runs of each text
 * TextKit 2 lays out, and each font a text's attributes print, with the
 * weight and line height their descriptions leave out.
 */
static NSDictionary *ResolveTextAttributes(NSData *tree) {
    return @{
        @"texts": Resolve(tree, "NSTextContentStorage: 0x", ^id(uintptr_t address) {
            NSTextContentStorage *storage = ObjectAt(address, NSTextContentStorage.class);
            return storage == nil ? nil : TextAttributes(storage);
        }),
        @"fonts": Resolve(tree, "UICTFont: 0x", ^id(uintptr_t address) {
            UIFont *font = ObjectAt(address, NSClassFromString(@"UICTFont"));
            return font == nil ? nil : FontAttributes(font);
        }),
    };
}

#pragma mark - The layout

static NSData *JSONData(id object) {
    return [NSJSONSerialization dataWithJSONObject:object options:0 error:NULL];
}

static NSDictionary *FrameJSON(CGRect rect) {
    return @{@"x": @(rect.origin.x), @"y": @(rect.origin.y),
             @"width": @(rect.size.width), @"height": @(rect.size.height)};
}

/**
 * The layout as one JSON document. Runs on the main thread, where SwiftUI and
 * UIKit may be read. Each hosting view's tree is spliced in as SwiftUI wrote
 * it.
 */
static NSData *Layout(void) {
    UIScreen *screen = UIScreen.mainScreen;
    NSMutableData *body = [NSMutableData dataWithBytes:"{\"screen\":" length:10];
    [body appendData:JSONData(@{@"width": @(screen.bounds.size.width),
                                @"height": @(screen.bounds.size.height),
                                @"scale": @(screen.scale)})];
    [body appendBytes:",\"hostingViews\":[" length:17];
    SEL makeViewDebugData = NSSelectorFromString(@"makeViewDebugData");
    BOOL first = YES;
    for (UIView *view in VisibleHostingViews(screen.bounds)) {
        NSData *tree = ((NSData *(*)(id, SEL))objc_msgSend)(view, makeViewDebugData);
        if (![tree isKindOfClass:NSData.class] || tree.length == 0) continue;
        NSMutableDictionary *described = [ResolveTextAttributes(tree) mutableCopy];
        described[@"frame"] = FrameJSON(ScreenFrame(view));
        NSData *head = JSONData(described);
        if (head == nil) continue;
        if (!first) [body appendBytes:"," length:1];
        first = NO;
        // {"frame":…,"texts":…,"fonts":…} gains "tree", spliced in last.
        [body appendBytes:head.bytes length:head.length - 1];
        [body appendBytes:",\"tree\":" length:8];
        [body appendData:tree];
        [body appendBytes:"}" length:1];
    }
    [body appendBytes:"]}" length:2];
    return body;
}

#pragma mark - Loopback server

static void Answer(int connection, int status, NSString *reason, NSData *body) {
    NSString *head = [NSString stringWithFormat:
        @"HTTP/1.1 %d %@\r\nContent-Type: application/json\r\nContent-Length: %lu\r\nConnection: close\r\n\r\n",
        status, reason, (unsigned long)body.length];
    NSMutableData *response = [[head dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
    [response appendData:body];
    const uint8_t *bytes = response.bytes;
    size_t left = response.length;
    while (left > 0) {
        ssize_t written = write(connection, bytes, left);
        if (written <= 0) break;
        bytes += written;
        left -= (size_t)written;
    }
}

static void AnswerError(int connection, int status, NSString *reason, NSString *message) {
    Answer(connection, status, reason, JSONData(@{@"error": message}) ?: [NSData data]);
}

/** Compares in time independent of where the two differ. */
static BOOL SameSecret(NSString *given) {
    NSData *a = [given dataUsingEncoding:NSUTF8StringEncoding];
    NSData *b = [Secret dataUsingEncoding:NSUTF8StringEncoding];
    if (a.length != b.length) return NO;
    const uint8_t *x = a.bytes, *y = b.bytes;
    uint8_t difference = 0;
    for (NSUInteger index = 0; index < a.length; index++) difference |= x[index] ^ y[index];
    return difference == 0;
}

static void HandleRequest(int connection) {
    char buffer[8192];
    size_t length = 0;
    while (length < sizeof buffer - 1) {
        ssize_t received = read(connection, buffer + length, sizeof buffer - 1 - length);
        if (received <= 0) break;
        length += (size_t)received;
        buffer[length] = 0;
        if (strstr(buffer, "\r\n\r\n") != NULL) break;
    }
    buffer[length] = 0;
    NSString *request = [[NSString alloc] initWithBytes:buffer length:length encoding:NSUTF8StringEncoding];
    NSArray<NSString *> *lines = [request componentsSeparatedByString:@"\r\n"];
    NSArray<NSString *> *requestLine = [lines.firstObject componentsSeparatedByString:@" "];
    NSString *authorization = nil;
    for (NSString *line in lines) {
        NSRange colon = [line rangeOfString:@":"];
        if (colon.location == NSNotFound) continue;
        NSString *name = [line substringToIndex:colon.location];
        if ([name caseInsensitiveCompare:@"Authorization"] == NSOrderedSame) {
            authorization = [[line substringFromIndex:colon.location + 1]
                stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        }
    }
    if (![authorization hasPrefix:@"Bearer "] || !SameSecret([authorization substringFromIndex:7])) {
        AnswerError(connection, 401, @"Unauthorized", @"The request has no valid secret.");
        return;
    }
    if (requestLine.count < 2 || ![requestLine[1] isEqualToString:@"/layout"]) {
        AnswerError(connection, 404, @"Not Found", @"Only /layout is served.");
        return;
    }
    if (![requestLine[0] isEqualToString:@"GET"]) {
        AnswerError(connection, 405, @"Method Not Allowed", @"/layout is read with GET.");
        return;
    }
    __block NSData *layout = nil;
    __block NSString *failure = nil;
    dispatch_sync(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            @try {
                layout = Layout();
            } @catch (NSException *exception) {
                failure = [NSString stringWithFormat:@"%@: %@", exception.name, exception.reason];
            }
        }
    });
    if (layout == nil) {
        AnswerError(connection, 500, @"Internal Server Error", failure ?: @"The layout could not be read.");
        return;
    }
    Answer(connection, 200, @"OK", layout);
}

static void Serve(int port) {
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0) {
        Log([NSString stringWithFormat:@"no socket: %s", strerror(errno)]);
        return;
    }
    // The Build's previous launch may have left the port in TIME_WAIT.
    int reuse = 1;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_port = htons((uint16_t)port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(listener, (struct sockaddr *)&address, sizeof address) != 0 || listen(listener, 16) != 0) {
        Log([NSString stringWithFormat:@"cannot listen on port %d: %s", port, strerror(errno)]);
        close(listener);
        return;
    }
    for (;;) {
        int connection = accept(listener, NULL, NULL);
        if (connection < 0) continue;
        // A server that leaves mid-answer must not end the Build with SIGPIPE,
        // and one that sends nothing must not hold the next request up.
        int on = 1;
        setsockopt(connection, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
        struct timeval timeout = {.tv_sec = 10};
        setsockopt(connection, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
        setsockopt(connection, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
        @autoreleasepool {
            @try {
                HandleRequest(connection);
            } @catch (NSException *exception) {
                AnswerError(connection, 500, @"Internal Server Error", exception.reason ?: exception.name);
            }
        }
        close(connection);
    }
}

__attribute__((constructor)) static void Start(void) {
    @try {
        const char *port = getenv("NITPICK_INSPECT_PORT");
        const char *secret = getenv("NITPICK_INSPECT_SECRET");
        if (port == NULL || secret == NULL || strlen(secret) < 32 || atoi(port) <= 0) return;
        Secret = @(secret);
        // The Build has no use for it, and shouldn't log it.
        unsetenv("NITPICK_INSPECT_SECRET");
        // SwiftUI reads this once, later than this constructor runs.
        setenv("SWIFTUI_VIEW_DEBUG", ViewDebugProperties, 0);
        int chosen = atoi(port);
        NSThread *server = [[NSThread alloc] initWithBlock:^{ Serve(chosen); }];
        server.name = @"nitpick inspect";
        [server start];
    } @catch (NSException *exception) {
        Log([NSString stringWithFormat:@"not started: %@", exception.reason]);
    }
}
