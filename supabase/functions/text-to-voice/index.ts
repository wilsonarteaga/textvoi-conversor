// deno-lint-ignore-file no-explicit-any
// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2.48.1'
import { corsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const ELEVEN_LABS_API_KEY = Deno.env.get('ELEVEN_LABS_API_KEY')!;
const ELEVEN_LABS_VOICE_ID = Deno.env.get('ELEVEN_LABS_VOICE_ID') || 'x5IDPSl4ZUbhosMmVFTk'; // Default voice
const BUCKET_NAME = Deno.env.get('BUCKET_NAME')!;

// const SUPABASE_URL='https://xbipbbvhrlfiiuapyfjk.supabase.co'
// const SUPABASE_ANON_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhiaXBiYnZocmxmaWl1YXB5ZmprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzk2Njc1NzAsImV4cCI6MjA1NTI0MzU3MH0.wVOQxKHhP4hBB3625HCPQCvnKRY3vt_jrZQh9qCV7NU'
// const ELEVEN_LABS_API_KEY = 'sk_2ceb5d34b254b252211d3ba698add8874168cfdd29995746'
// const ELEVEN_LABS_VOICE_ID ='x5IDPSl4ZUbhosMmVFTk'
// const BUCKET_NAME='textvoi'

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
)

Deno.serve(async (req) => {
  const { id } = await req.json()

  if (!id) {
    return new Response(JSON.stringify({ error: 'Id parameter is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {

    const { data: row, error } = await supabase
      .from('process')
      .select('*')
      .eq('id', id)
      .single(); 

    if (error) {
      console.error('Error fetching row:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (row) {
      console.log('Row data:', row);
    } else {
      console.log('Row not found or error occurred.');
      return new Response(JSON.stringify({ error: 'Row not found or error occurred.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    
    if (!ELEVEN_LABS_API_KEY) {
        return new Response(JSON.stringify({ error: 'Eleven Labs API Key not set' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
    }

    let text = row?.content;

    if (row.is_file) {

      const { data: publicTextUrl } = supabase.storage.from(BUCKET_NAME).getPublicUrl(row.bucket_key_text);

      console.log('📌 - index.ts:77 - Deno.serve - publicTextUrl:', publicTextUrl.publicUrl);

      const { data: dataDownload, error } = await supabase.storage
        .from(BUCKET_NAME)
        .download(row.bucket_key_text);
      
      if (error) {
        console.error('Error downloading file:', error);
        return new Response(JSON.stringify({ error: `Error downloading file: ${error}` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
      }

      if (!dataDownload) {
        console.warn('File download was successful, but data is null.');
        return new Response(JSON.stringify({ error: 'File download was successful, but data is null.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      text = await dataDownload.text();
    }

    console.log('Text to be converted:', text);

    const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_LABS_VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_LABS_API_KEY,
        'Content-Type': 'application/json',
        ...corsHeaders, // Include CORS headers in the Eleven Labs request
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_monolingual_v1', // Optional: Specify the model
        voice_settings: {
          stability: 0.5,  // Adjust these parameters for desired voice quality
          similarity_boost: 0.5
        }
      }),
    });

    if (!ttsResponse.ok) {
      console.error('Eleven Labs API Error:', ttsResponse.status, ttsResponse.statusText, await ttsResponse.text());
      return new Response(JSON.stringify({ error: `Eleven Labs API Error: ${ttsResponse.statusText}` }), {
        status: ttsResponse.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const audioBuffer = await ttsResponse.arrayBuffer(); // Get the response as an ArrayBuffer

    const filename = `tts-${Date.now()}.mp3`;

    const { data: dataStorage, error: storageError } = await supabase.storage
      .from(BUCKET_NAME) // Replace 'audio' with your storage bucket name
      .upload(filename, audioBuffer, {
        contentType: 'audio/mpeg', // Set the correct content type
        upsert: false
      });

    if (storageError) {
      console.error('Supabase Storage Error:', storageError);
      return new Response(JSON.stringify({ error: `Supabase Storage Error: ${storageError.message}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const { data: publicUrlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(filename);

    if (!publicUrlData || !publicUrlData.publicUrl) {
      console.error('Failed to generate public URL for audio');
      return new Response(JSON.stringify({ error: 'Failed to generate public URL for audio' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const updates = {
      bucket_key_voice: publicUrlData.publicUrl
    };

    const { data: updatedRow, error: updateError } = await supabase
      .from('process')
      .update(updates) 
      .eq('id', id)
      .select('*')
      .single();

    if (updateError) {
      console.error('Error updating row:', updateError);
      return new Response(JSON.stringify({ error: updateError.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log('📌 - index.ts:147 - Deno.serve - updatedRow:', updatedRow);
    
    return new Response(
      JSON.stringify({ audio: filename, audioUrl: publicUrlData.publicUrl }),
      { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  } catch (error) {
    console.error('Function Error:', error);
    return new Response(JSON.stringify({ error: (error as any).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/text-to-voice' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
