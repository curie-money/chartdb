import React, { useState } from 'react';
import { Share2 } from 'lucide-react';
import { Button } from '@/components/button/button';
import { ShareDialog } from '@/dialogs/share-dialog/share-dialog';
import { DbdHighlightLegend } from './dbd-highlight-legend';

export const ShareButton: React.FC = () => {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => setOpen(true)}
            >
                <Share2 className="size-4" />
                Share
            </Button>
            <ShareDialog open={open} onOpenChange={setOpen} />
            <DbdHighlightLegend />
        </>
    );
};
